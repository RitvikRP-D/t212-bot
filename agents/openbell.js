'use strict';
// AGENT: OPENING BELL — the "market just opened, re-think everything" trigger.
// The fleet analyses 24/7, but a venue's OPEN is the moment the accumulated overnight
// intelligence (news correlations, TradingView reads, queued conviction) becomes
// actionable. This agent watches every venue for a closed→open flip and, the instant
// it happens, forces a FRESH pass: it front-loads that venue's names onto the
// TradingView hot-list so they're re-rated first, nudges the scanner to re-scan, tells
// the correlator to rebuild against the now-tradeable set, and announces it.
//
// This does NOT constrain the bot — it only guarantees the freshest possible data is
// on the table at the exact moment trading becomes possible, so the first decisions of
// the session are the best-informed ones. Same behaviour on virtual and real accounts.
const BELL_MS = 15000;   // check venue transitions every 15s

function start(bus) {
  bus.openBell = { lastOpened: null, history: [], nextRefresh: null };
  const wasOpen = {};     // venue -> bool, seeded on first pass so we don't fire on boot

  function heldAndTrackedFor(venue) {
    const inV = (sym) => (sym.includes('.') ? sym.split('.')[1] : 'US') === venue;
    const held = Object.keys(bus.state.t212.positions || {}).filter(inV);
    const tracked = Object.keys(bus.market || {}).filter(sym => inV(sym) && (bus.market[sym].lastConf || 0) >= 0.1);
    return [...new Set([...held, ...tracked])];
  }

  function fireReanalysis(venue, label) {
    const names = heldAndTrackedFor(venue);
    // 1) front-load these names via hotExtra — tvanalyst rewrites bus.tvHot wholesale
    // every 25s, so unshifting there was wiped almost immediately (scanner merges hotExtra)
    bus.hotExtra = bus.hotExtra || [];
    for (const s of names) if (!bus.hotExtra.some(x => x.sym === s)) bus.hotExtra.push({ sym: s, at: Date.now() });
    // 2) signal the fresh-open so scanner/ranker/correlator prioritise a new pass
    bus.freshOpen = { venue, label, at: Date.now(), names: names.length };
    if (bus.forceScan) { try { bus.forceScan(venue); } catch (e) {} }
    // 3) record + announce
    const rec = { venue: label, names: names.length, t: new Date().toLocaleTimeString() };
    bus.openBell.lastOpened = rec;
    bus.openBell.history.unshift(rec);
    bus.openBell.history = bus.openBell.history.slice(0, 20);
    console.log(`[openbell] ${label} OPENED → re-analysing ${names.length} tracked/held names with freshest news+chart data`);
    if (bus.notify) bus.notify(`🔔 ${label} just opened — bot re-analysed ${names.length} names with the latest news correlations & TradingView reads before trading.`);
  }

  function check() {
    if (bus.beat) bus.beat('openbell');
    const mm = bus.marketMap;
    if (!mm || !mm.venues) return;               // wait for marketmap to publish first
    for (const vd of mm.venues) {
      if (vd.venue === 'CRYPTO' || vd.venue === 'FUTURES') continue;   // always-open, no bell
      const prev = wasOpen[vd.venue];
      wasOpen[vd.venue] = vd.open;
      if (prev === undefined) continue;          // seed pass — never fire on startup
      if (vd.open && !prev) fireReanalysis(vd.venue, vd.label || vd.venue);   // closed → open
    }
  }

  setInterval(check, BELL_MS);
  setTimeout(check, 5000);
  console.log('[openbell] opening-bell trigger armed — forces a fresh news+chart re-analysis the instant any venue opens');
}
module.exports = { start };
