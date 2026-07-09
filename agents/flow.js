'use strict';
// AGENT: SECTOR FLOW & RELATIVE STRENGTH — answers "where is today's money going?"
// Groups every scanned name by sector, computes each sector's median day-move, and
// flags the LEADERS: names outrunning their own (hot) sector on real volume. Buying
// the strongest name in the strongest sector is one of the oldest documented intraday
// edges; buying a laggard in a cold sector is donating money. Publishes:
//   bus.flow        — dashboard board  { sectors, leaders, updated }
//   bus.flowSignal  — sym -> strength (0..1), folded into trader conf + votes
const { sectorOf } = require('../lib/fleet');

const FLOW_MS = 30000;

function median(a) { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function start(bus) {
  bus.flow = { sectors: [], leaders: [], updated: null };
  bus.flowSignal = {};

  function tick() {
    if (bus.beat) bus.beat('flow');
    const bySec = {};
    for (const [sym, mk] of Object.entries(bus.market || {})) {
      if (mk.pct24h == null || mk.price == null) continue;
      const sec = sectorOf(sym);
      if (sec === 'other' || sec === 'index') continue;
      (bySec[sec] = bySec[sec] || []).push({ sym, pct: mk.pct24h, vol: mk.volSurge || 0 });
    }
    const sectors = Object.entries(bySec).filter(([, arr]) => arr.length >= 5)
      .map(([sector, arr]) => ({ sector, median: +median(arr.map(x => x.pct)).toFixed(2), n: arr.length }))
      .sort((a, b) => b.median - a.median);
    const hot = new Set(sectors.filter(s => s.median > 0.3).slice(0, 3).map(s => s.sector));
    const cold = new Set(sectors.filter(s => s.median < -0.3).map(s => s.sector));

    const signal = {}, leaders = [];
    for (const [sec, arr] of Object.entries(bySec)) {
      const med = median(arr.map(x => x.pct));
      for (const x of arr) {
        // leader: beats its sector by ≥1.2 points on ≥1.2× volume, in a HOT sector
        if (hot.has(sec) && x.pct >= med + 1.2 && x.vol >= 1.2) {
          const strength = +Math.min(1, (x.pct - med) / 4 + 0.3).toFixed(2);
          signal[x.sym] = strength;
          leaders.push({ sym: x.sym, sector: sec, pct: +x.pct.toFixed(2), vsSector: +(x.pct - med).toFixed(2), strength });
        }
        // laggard in a cold sector: negative signal (trader docks it)
        else if (cold.has(sec) && x.pct <= med - 1.2) signal[x.sym] = -0.3;
      }
    }
    leaders.sort((a, b) => b.strength - a.strength);
    bus.flowSignal = signal;
    bus.flow = { sectors: sectors.slice(0, 12), leaders: leaders.slice(0, 15), hot: [...hot], cold: [...cold], updated: new Date().toLocaleTimeString() };
  }

  setInterval(tick, FLOW_MS);
  setTimeout(tick, 20000);
  console.log('[flow] sector-flow & relative-strength agent armed — hunting the day\'s strongest names in the strongest sectors');
}
module.exports = { start };
