'use strict';
// AGENT ⑥: TradingView analyst — pulls TradingView's own technical ratings
// (Recommend.All: the composite Buy/Sell gauge built from ~26 indicators across
// moving averages + oscillators, i.e. TradingView's read of every candle) for all
// 8 markets we trade, via the same scanner endpoint tradingview.com itself uses.
// Ratings flow into: trader entry confidence, exit checks, the scanner hot list,
// and the dashboard (label + embedded TradingView chart).
const { TV_MS } = require('../config');

const MARKETS = [
  { id: 'america',     ex: ['NYSE', 'NASDAQ', 'AMEX', 'CBOE'], toY: n => n.replace(/\./g, '-') },
  { id: 'uk',          ex: ['LSE'],      toY: n => n.replace(/\./g, '-') + '.L' },
  { id: 'germany',     ex: ['XETR'],     toY: n => n + '.DE' },
  { id: 'france',      ex: ['EURONEXT'], toY: n => n + '.PA' },
  { id: 'netherlands', ex: ['EURONEXT'], toY: n => n + '.AS' },
  { id: 'switzerland', ex: ['SIX'],      toY: n => n + '.SW' },
  { id: 'italy',       ex: ['MIL'],      toY: n => n + '.MI' },
  { id: 'spain',       ex: ['BME'],      toY: n => n + '.MC' },
];

function label(rec) {
  return rec >= 0.5 ? 'STRONG BUY' : rec >= 0.1 ? 'BUY' : rec <= -0.5 ? 'STRONG SELL' : rec <= -0.1 ? 'SELL' : 'NEUTRAL';
}

function start(bus) {
  bus.tvRatings = {};
  bus.tvHot = [];
  bus.tvaStatus = { rated: 0, matched: 0, lastMarket: null, updated: null, errors: 0 };
  let idx = 0;

  async function scanMarket(mkt) {
    const body = {
      filter: [
        { left: 'type', operation: 'in_range', right: ['stock', 'fund'] },
        { left: 'exchange', operation: 'in_range', right: mkt.ex },
        { left: 'volume', operation: 'greater', right: 10000 },
      ],
      markets: [mkt.id],
      symbols: { query: { types: [] }, tickers: [] },
      columns: ['name', 'close', 'change', 'Recommend.All', 'Recommend.MA', 'Recommend.Other', 'RSI'],
      sort: { sortBy: 'Recommend.All', sortOrder: 'desc' },
      range: [0, 400],
    };
    const r = await fetch(`https://scanner.tradingview.com/${mkt.id}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { bus.tvaStatus.errors++; return; }
    const j = await r.json();
    const inUni = new Set(bus.universe.map(u => u.y));
    let matched = 0;
    for (const row of j.data || []) {
      const [name, close, change, rec, recMA, recOther, rsi] = row.d;
      const y = mkt.toY(name);
      if (!inUni.has(y)) continue;
      bus.tvRatings[y] = { rec, recMA, recOther, rsi, label: label(rec), tvName: row.s, at: Date.now() };
      matched++;
    }
    bus.tvaStatus.lastMarket = mkt.id + ` (${matched} in universe)`;
    bus.tvaStatus.updated = new Date().toLocaleTimeString();
    bus.tvaStatus.matched += matched;
    // expire stale ratings, rebuild counts + hot list of TV strong-buys we can actually trade
    const cutoff = Date.now() - 30 * 60e3;
    for (const [sym, v] of Object.entries(bus.tvRatings)) if (v.at < cutoff) delete bus.tvRatings[sym];
    bus.tvaStatus.rated = Object.keys(bus.tvRatings).length;
    bus.tvHot = Object.entries(bus.tvRatings)
      .filter(([, v]) => v.rec >= 0.5)
      .sort((a, b) => b[1].rec - a[1].rec)
      .slice(0, 40)
      .map(([sym]) => sym);
  }

  setInterval(() => {
    scanMarket(MARKETS[idx++ % MARKETS.length]).catch(() => { bus.tvaStatus.errors++; });
  }, TV_MS);
  scanMarket(MARKETS[0]).catch(() => { bus.tvaStatus.errors++; });
  console.log('[tvanalyst] agent started — TradingView ratings for 8 markets');
}
module.exports = { start };
