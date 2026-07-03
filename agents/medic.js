'use strict';
// AGENT ⑧: MEDIC — the self-healing engineer that lives on the server.
// Watches every other agent's heartbeat/counters. If an agent stalls, it logs the
// incident, tries a soft revive (re-kicking its loop via the bus), and if the
// process itself is wedged it saves state and exits(1) so the supervisor
// (launchd locally / GitHub Actions in the cloud) restarts everything clean.
// Also traps uncaught exceptions and memory bloat, so one bad agent can't kill
// the fleet while your Mac is closed.
const { MEDIC_MS } = require('../config');

function start(bus) {
  bus.beats = bus.beats || {};
  bus.beat = (name) => { bus.beats[name] = Date.now(); };
  bus.medicStatus = { watching: 0, revived: 0, incidents: [], lastCheck: null, memMB: 0 };
  const last = {}; // name -> {val, changedAt}

  function incident(msg) {
    bus.medicStatus.incidents.unshift({ t: new Date().toLocaleTimeString(), msg });
    bus.medicStatus.incidents = bus.medicStatus.incidents.slice(0, 25);
    console.log('[medic] ' + msg);
  }

  // WATCHERS: counter must move within graceMin (some only matter when markets open)
  const WATCH = [
    { name: 'scanner',    val: () => bus.scanStatus && bus.scanStatus.scanned + bus.scanStatus.errors, graceMin: 12, needsOpen: () => (bus.scanStatus?.openNow || 0) > 0 },
    { name: 'tvanalyst',  val: () => bus.tvaStatus && bus.tvaStatus.rated + bus.tvaStatus.errors, graceMin: 15 },
    { name: 'news',       val: () => bus.news && bus.news.updated, graceMin: 30 },
    { name: 'crypto',     val: () => bus.cryptoStatus && bus.cryptoStatus.scanned + bus.cryptoStatus.errors, graceMin: 12 },
    { name: 'cryptoTV',   val: () => bus.ctvStatus && bus.ctvStatus.rated + bus.ctvStatus.errors, graceMin: 20 },
    { name: 'commodities',val: () => bus.commodStatus && bus.commodStatus.scanned + bus.commodStatus.errors, graceMin: 20 },
    { name: 'livenews',   val: () => bus.deepNews && bus.deepNews.updated, graceMin: 45 },
    { name: 'ranker',     val: () => bus.rankStatus && bus.rankStatus.scanned + bus.rankStatus.errors, graceMin: 25 },
    { name: 'history',    val: () => bus.histStatus && bus.histStatus.analyzed + bus.histStatus.errors, graceMin: 40 },
    { name: 'risk',       val: () => bus.riskStatus && bus.riskStatus.checked, graceMin: 5 },
    { name: 'logger',     val: () => bus.logStatus && bus.logStatus.lastXlsx, graceMin: 20 },
    { name: 'allocator',  val: () => bus.allocStatus && bus.allocStatus.checked, graceMin: 10 },
    { name: 'marketmap',  val: () => bus.marketMap && bus.marketMap.updated, graceMin: 10 },
    { name: 'sentinel',   val: () => bus.sentinelStatus && bus.sentinelStatus.checked, graceMin: 10 },
  ];

  let strikes = 0;
  function check() {
    bus.medicStatus.lastCheck = new Date().toLocaleTimeString();
    bus.medicStatus.watching = WATCH.length;
    const mem = process.memoryUsage().rss / 1048576;
    bus.medicStatus.memMB = Math.round(mem);
    if (mem > 1400) { incident(`memory ${Math.round(mem)}MB — saving state and restarting fleet`); return die(); }
    let stalled = 0;
    for (const w of WATCH) {
      let v; try { v = w.val(); } catch (e) { v = null; }
      if (v == null) continue; // agent not started yet
      if (w.needsOpen && !w.needsOpen()) { last[w.name] = { val: v, changedAt: Date.now() }; continue; }
      const rec = last[w.name];
      if (!rec || rec.val !== v) { last[w.name] = { val: v, changedAt: Date.now() }; continue; }
      const stallMin = (Date.now() - rec.changedAt) / 60000;
      if (stallMin > w.graceMin) {
        stalled++;
        incident(`${w.name} stalled ${stallMin.toFixed(0)}min (grace ${w.graceMin}) — reviving`);
        if (bus.revive && bus.revive[w.name]) { try { bus.revive[w.name](); bus.medicStatus.revived++; last[w.name].changedAt = Date.now(); } catch (e) {} }
      }
    }
    if (stalled >= 4) { strikes++; incident(`${stalled} agents stalled (strike ${strikes}/3)`); } else strikes = 0;
    if (strikes >= 3) { incident('fleet wedged — full restart'); die(); }
  }
  function die() {
    try { if (bus.saveNow) bus.saveNow(); } catch (e) {}
    setTimeout(() => process.exit(1), 1500); // supervisor restarts us with state intact
  }

  process.on('uncaughtException', (e) => { incident('uncaught: ' + (e && e.message || e)); });
  process.on('unhandledRejection', (e) => { incident('rejection: ' + (e && e.message || e)); });

  setInterval(check, MEDIC_MS);
  console.log('[medic] self-healer watching ' + WATCH.length + ' agents');
}
module.exports = { start };
