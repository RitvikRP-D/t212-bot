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
      // extendedMetrics needs 21 bars — with fewer, stale prior-session vwap/volume
      // metrics would silently survive against fresh prices right after the open
      if (closes.length < 21) return;
      // LSE quotes arrive in GBX PENCE ('GBp') — normalize to pounds BEFORE any math,
      // or every .L order is sized 100x wrong and P&L/equity mixes pence with pounds
      if (res.meta.currency === 'GBp') {
        for (const a of [opens, highs, lows, closes]) for (let i = 0; i < a.length; i++) a[i] /= 100;
        if (res.meta.regularMarketPrice) res.meta.regularMarketPrice /= 100;
        if (res.meta.chartPreviousClose) res.meta.chartPreviousClose /= 100;
        if (res.meta.previousClose) res.meta.previousClose /= 100;
        res.meta.currency = 'GBP';
      }
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
      mk.lastTickAt = Date.now();
      // timestamp of the newest 1-min bar — if it's hours old while the clock says
      // "open", the venue is on holiday/halted and orders would just queue+block cash
      const ts = res.timestamp;
      mk.lastBarAt = ts && ts.length ? ts[ts.length - 1] * 1000 : null;
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
    // hotExtra: additive priority channel (openbell/allocator) — tvanalyst rewrites
    // bus.tvHot wholesale every 25s, so injections there were wiped almost instantly
    const extra = (bus.hotExtra || []).filter(x => Date.now() - x.at < 15 * 60e3).map(x => x.sym);
    if (bus.hotExtra && extra.length !== bus.hotExtra.length) bus.hotExtra = bus.hotExtra.filter(x => Date.now() - x.at < 15 * 60e3);
    // SPY is pinned hot: the trader's market-tape gate needs a fresh index read at all times
    const hot = [...new Set([...holdings, 'SPY', ...extra, ...(bus.tvHot || []), ...open.filter(s => (bus.market[s]?.lastConf || 0) >= 0.15)])].filter(marketOpen);
    if (slot % HOT_EVERY === 0 && hot.length) { fetchSym(hot[hotIdx++ % hot.length]); return; }
    // FULL-PASS LANE with junk deprioritization: a full rotation over ~7k open names takes
    // ~40 min, so every wasted slot matters. Names already known to be illiquid junk
    // (thin volume or sub-$2) only get 1 of every 3 of their turns — tripling the refresh
    // rate of everything actually tradeable.
    for (let tries = 0; tries < 8; tries++) {
      const sym = open[fullIdx++ % open.length];
      const known = bus.market[sym];
      const junk = known && ((known.notionalPerMin != null && known.notionalPerMin < 3000) || (known.price != null && known.price < 2 && !sym.includes('.')));
      if (junk && fullIdx % 3 !== 0) continue;
      fetchSym(sym);
      return;
    }
    fetchSym(open[fullIdx++ % open.length]);
  }, SCAN_MS);
  console.log('[scanner] started');
}
module.exports = { start };
