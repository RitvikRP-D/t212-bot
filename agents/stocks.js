'use strict';
// AGENT ①: market scanner — real 1-min candles from Yahoo's public chart API.
// Two-tier: full universe rotates continuously; a "hot list" (holdings + strongest
// signals) gets rescanned ~every minute so exits and live setups stay fresh.
const { SCAN_MS, HOT_EVERY, marketOpen } = require('../config');
const { calcRSI, calcMACD, extendedMetrics } = require('../lib/indicators');

function start(bus) {
  bus.scanStatus = { scanned: 0, errors: 0, openNow: 0, universe: 0, lastSym: null, fullPassMins: null, backoffUntil: 0 };
  let fullIdx = 0, hotIdx = 0, slot = 0;

  async function fetchSym(sym) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
      });
      if (r.status === 429) { bus.scanStatus.backoffUntil = Date.now() + 60000; return; }
      if (!r.ok) { bus.scanStatus.errors++; return; }
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) { bus.scanStatus.errors++; return; }
      const q = res.indicators.quote[0];
      const opens = [], highs = [], lows = [], closes = [], vols = [];
      for (let i = 0; i < (q.close || []).length; i++) {
        if (q.close[i] == null) continue;
        closes.push(q.close[i]);
        opens.push(q.open?.[i] ?? q.close[i]);
        highs.push(q.high?.[i] ?? q.close[i]);
        lows.push(q.low?.[i] ?? q.close[i]);
        vols.push(q.volume?.[i] ?? 0);
      }
      if (closes.length < 15) return;
      const mk = bus.market[sym] = bus.market[sym] || {};
      mk.closes = closes.slice(-120);
      Object.assign(mk, extendedMetrics(opens.slice(-120), highs.slice(-120), lows.slice(-120), closes.slice(-120), vols.slice(-120)));
      mk.price = res.meta.regularMarketPrice || closes[closes.length-1];
      const prev = res.meta.chartPreviousClose || res.meta.previousClose;
      mk.pct24h = prev ? (mk.price - prev) / prev * 100 : null;
      mk.currency = res.meta.currency;
      mk.rsi = calcRSI(mk.closes);
      const m = calcMACD(mk.closes);
      if (m) { mk.macdHist = m.hist; mk.crossUp = m.crossUp; mk.crossDown = m.crossDown; }
      mk.lastTick = new Date().toLocaleTimeString();
      bus.scanStatus.scanned++;
      bus.scanStatus.lastSym = sym;
      if (bus.onTick) bus.onTick(sym);
    } catch (e) { bus.scanStatus.errors++; }
  }

  setInterval(() => {
    if (Date.now() < bus.scanStatus.backoffUntil) return;
    const uni = bus.universe.map(u => u.y);
    bus.scanStatus.universe = uni.length;
    const open = uni.filter(marketOpen);
    bus.scanStatus.openNow = open.length;
    if (!open.length) return;
    bus.scanStatus.fullPassMins = +((open.length * SCAN_MS) / 60000).toFixed(1);
    slot++;
    const holdings = Object.keys(bus.state.paper.positions).concat(Object.keys(bus.state.t212.positions));
    const hot = [...new Set([...holdings, ...(bus.tvHot || []), ...open.filter(s => (bus.market[s]?.lastConf || 0) >= 0.15)])].filter(marketOpen);
    if (slot % HOT_EVERY === 0 && hot.length) fetchSym(hot[hotIdx++ % hot.length]);
    else fetchSym(open[fullIdx++ % open.length]);
  }, SCAN_MS);
  console.log('[scanner] started');
}
module.exports = { start };
