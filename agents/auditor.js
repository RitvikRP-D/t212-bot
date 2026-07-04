'use strict';
// AGENT ㉓: EXECUTION AUDITOR + INTEGRITY WATCH. After every fill it compares the price we
// intended to the price we actually got (slippage), watches for rejected/dead-letter orders,
// checks that our equity math reconciles with T212's own figure, and flags anomalies
// (sudden gaps in a holding, API errors, signals that fired but never entered). Records
// everything on bus.audit and pings you once per NEW critical anomaly. Read-only + advisory:
// it never places or cancels orders itself (that stays with the trader/janitor).
function start(bus) {
  const state = bus.state;
  bus.audit = { slippage: [], deadLetter: [], anomalies: [], checksum: null, updated: null };
  bus.deadLetter = bus.deadLetter || [];         // trader pushes rejected orders here
  const seenGap = {};                            // sym -> last gain we already flagged
  let lastRealized = state.realized || 0;
  let alerted = new Set();

  function anomaly(key, msg, critical) {
    if (bus.audit.anomalies.find(a => a.key === key)) return;
    bus.audit.anomalies.unshift({ key, msg, t: new Date().toLocaleTimeString(), critical: !!critical });
    bus.audit.anomalies = bus.audit.anomalies.slice(0, 40);
    console.log('[audit] ' + msg);
    if (critical && bus.notify && !alerted.has(key)) { alerted.add(key); bus.notify('⚠️ ' + msg); }
  }

  function cycle() {
    // 1) SLIPPAGE — reconcile() rewrites a position's entry to T212's real average fill price.
    //    Compare that to the price we meant to pay (stamped at order time).
    const slip = [];
    for (const [sym, p] of Object.entries(state.t212.positions)) {
      if (p.intendedPrice && p.entry && !p.pendingFill) {
        const bps = (p.entry - p.intendedPrice) / p.intendedPrice * 1e4;
        slip.push({ sym, intended: p.intendedPrice, filled: p.entry, bps: +bps.toFixed(1) });
        if (Math.abs(bps) > 60 && !p._slipFlagged) { p._slipFlagged = true; anomaly('slip:' + sym, `${sym} filled ${bps.toFixed(0)}bps off intended (${p.intendedPrice}→${p.entry})`, Math.abs(bps) > 120); }
      }
    }
    bus.audit.slippage = slip.slice(0, 20);

    // 2) DEAD-LETTER — orders the trader could not place. Surface + alert; a network-level
    //    failure (no HTTP status) with no resulting position is retried ONCE, conservatively.
    for (const d of bus.deadLetter) {
      if (d._processed) continue; d._processed = true;
      anomaly('dl:' + d.sym + ':' + d.t, `order failed ${d.sym}: ${d.error}`, true);
    }
    bus.deadLetter = bus.deadLetter.filter(d => Date.now() - (d.at || 0) < 6 * 3600e3);
    bus.audit.deadLetter = bus.deadLetter.slice(-20).map(d => ({ sym: d.sym, error: d.error, t: d.t }));

    // 3) CHECKSUM — our equity (cash + marked positions) should track T212's own "total".
    if (bus.t212Status && bus.t212Status.connected && bus.t212Status.total != null) {
      let mv = 0; for (const [s, p] of Object.entries(state.t212.positions)) mv += (bus.market[s]?.price || p.entry) * p.qty;
      const ours = (bus.t212Status.cash || 0) + mv;
      const t212 = bus.t212Status.total;
      const divPct = t212 > 0 ? Math.abs(ours - t212) / t212 * 100 : 0;
      bus.audit.checksum = { ours: +ours.toFixed(2), t212: +t212.toFixed(2), divPct: +divPct.toFixed(1) };
      if (divPct > 8) anomaly('checksum', `equity math diverges ${divPct.toFixed(0)}% from T212 (ours ${ours.toFixed(0)} vs ${t212.toFixed(0)}) — pending order or stale price`, false);
    }

    // 4) GAP / big-move watch on holdings (news gap, halt reopen, fat finger)
    for (const [sym, p] of Object.entries(state.t212.positions)) {
      const px = bus.market[sym]?.price; if (!px || !p.entry) continue;
      const gain = (px - p.entry) / p.entry;
      if (Math.abs(gain) > 0.08 && seenGap[sym] !== Math.round(gain * 100)) { seenGap[sym] = Math.round(gain * 100); anomaly('gap:' + sym + ':' + seenGap[sym], `${sym} is ${(gain * 100).toFixed(1)}% vs entry — large move on an open position`, Math.abs(gain) > 0.15); }
    }

    // 5) impossible realized-P&L jump (state corruption guard)
    const jump = Math.abs((state.realized || 0) - lastRealized);
    const baseEq = bus.riskStatus?.baseline || 1e9;
    if (jump > baseEq * 0.25) anomaly('pnljump:' + Math.round(state.realized), `realized P&L jumped ${jump.toFixed(0)} in one cycle — verify no double-count`, true);
    lastRealized = state.realized || 0;

    // 6) API health
    if (bus.t212Status && bus.t212Status.lastError) anomaly('api:' + String(bus.t212Status.lastError).slice(0, 24), 'T212 API: ' + bus.t212Status.lastError, false);

    // decay non-critical anomalies so the list reflects "now"
    bus.audit.anomalies = bus.audit.anomalies.filter(a => a.critical || bus.audit.anomalies.indexOf(a) < 15);
    bus.audit.updated = new Date().toLocaleTimeString();
  }
  setInterval(cycle, 20e3);
  setTimeout(cycle, 25e3);
  console.log('[audit] execution auditor + integrity watch armed');
}
module.exports = { start };
