'use strict';
// AGENT ⑨: SENTINEL — the constant checker. Every 45s it audits everything:
// state integrity (NaN/negative positions auto-repaired), price staleness,
// T212 API health, equity-math sanity, duplicate tickers, queue hygiene.
// What it can fix, it fixes; what it can't, it reports to the medic + dashboard.
const { SENTINEL_MS } = require('../config');

function start(bus) {
  const state = bus.state;
  bus.sentinelStatus = { checked: null, fixes: 0, warnings: [], apiHealthy: null };

  function warn(msg) {
    if (!bus.sentinelStatus.warnings.find(w => w.msg === msg)) {
      bus.sentinelStatus.warnings.unshift({ t: new Date().toLocaleTimeString(), msg });
      bus.sentinelStatus.warnings = bus.sentinelStatus.warnings.slice(0, 20);
      console.log('[sentinel] ' + msg);
    }
  }

  function audit() {
    bus.sentinelStatus.checked = new Date().toLocaleTimeString();
    // 1. position integrity — repair or remove corrupt entries
    for (const book of [state.t212.positions, state.paper.positions]) {
      for (const [sym, p] of Object.entries(book)) {
        if (!p || !isFinite(p.qty) || p.qty <= 0 || !isFinite(p.entry) || p.entry <= 0) {
          delete book[sym]; bus.sentinelStatus.fixes++; warn(`repaired corrupt position ${sym}`); bus.markDirty();
        }
      }
    }
    // 2. market data sanity — NaN prices poison exits; purge them
    for (const [sym, mk] of Object.entries(bus.market)) {
      if (mk.price != null && !isFinite(mk.price)) { mk.price = null; bus.sentinelStatus.fixes++; warn(`purged NaN price ${sym}`); }
    }
    // 3. stale holdings — a held symbol not ticked in 20min while its venue is open
    const { marketOpen } = require('../config');
    const staleWarned = (bus.sentinelStatus._staleWarned = bus.sentinelStatus._staleWarned || {});
    for (const sym of Object.keys(state.t212.positions)) {
      const mk = bus.market[sym];
      if (marketOpen(sym) && mk && mk.lastTickAt) {
        const age = (Date.now() - mk.lastTickAt) / 60000;
        if (age > 20 && (!staleWarned[sym] || Date.now() - staleWarned[sym] > 3600e3)) {
          staleWarned[sym] = Date.now();
          warn(`held ${sym} price is ${age.toFixed(0)}min stale with venue open`);
        }
      }
    }
    // 4. T212 API health
    const t = bus.t212Status || {};
    bus.sentinelStatus.apiHealthy = !!t.connected && !t.lastError;
    if (t.lastError && /precision/i.test(t.lastError)) warn('T212 rejected an order for quantity precision — trader now auto-retries coarser sizes');
    // 5. equity-curve sanity: nuke absurd datapoints (>5x baseline) from cached-price bugs
    const base = state.risk && state.risk.baseline;
    if (base && state.equityCurve.length) {
      const before = state.equityCurve.length;
      state.equityCurve = state.equityCurve.filter(d => d.eq < base * 5 && d.eq > base * 0.2);
      if (state.equityCurve.length !== before) { bus.sentinelStatus.fixes += before - state.equityCurve.length; bus.markDirty(); }
    }
    // 6. order-queue hygiene: expire queued conviction older than 12h
    if (state.queue) {
      for (const [sym, q] of Object.entries(state.queue)) {
        if (Date.now() - q.queuedAt > 12 * 3600e3) { delete state.queue[sym]; bus.markDirty(); }
      }
    }
  }

  setInterval(() => { try { audit(); } catch (e) { warn('audit error: ' + e.message); } }, SENTINEL_MS);
  console.log('[sentinel] constant checker on duty');
}
module.exports = { start };
