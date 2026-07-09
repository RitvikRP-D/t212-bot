'use strict';
// AGENT ⑥: TradingView analyst — pulls 122 TradingView-computed metrics per symbol
// (validated against their scanner: full MA suite, Ichimoku, SAR, ADX/DI, Aroon,
// every oscillator, ATR/Bollinger/volatility, 31 pivot levels across 5 systems,
// 25 candlestick patterns, beta, 52-week structure) for 8 markets, then fuses them
// into one composite score with a human-readable breakdown. Feeds: trader entry
// confidence, exit checks, scanner hot list, dashboard label + embedded chart.
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

const COLS = ['Recommend.All','Recommend.MA','Recommend.Other','RSI','RSI[1]','Stoch.K','Stoch.D','Stoch.K[1]','Stoch.D[1]','Stoch.RSI.K','CCI20','CCI20[1]','ADX','ADX+DI','ADX-DI','ADX+DI[1]','ADX-DI[1]','AO','AO[1]','AO[2]','Mom','Mom[1]','MACD.macd','MACD.signal','W.R','UO','BBPower','close','open','high','low','volume','change',
'EMA5','EMA10','EMA20','EMA30','EMA50','EMA100','EMA200','SMA5','SMA10','SMA20','SMA30','SMA50','SMA100','SMA200','HullMA9','VWMA','Ichimoku.BLine','P.SAR','BB.lower','BB.upper','ATR','Volatility.D','Volatility.W','Volatility.M','Aroon.Up','Aroon.Down','ROC','beta_1_year','price_52_week_high','price_52_week_low','average_volume_10d_calc','MoneyFlow','ChaikinMoneyFlow',
...['Classic','Fibonacci','Camarilla','Woodie'].flatMap(s => ['S3','S2','S1','Middle','R1','R2','R3'].map(l => `Pivot.M.${s}.${l}`)),
'Pivot.M.Demark.S1','Pivot.M.Demark.Middle','Pivot.M.Demark.R1',
'Candle.Doji','Candle.Doji.Dragonfly','Candle.Doji.Gravestone','Candle.Engulfing.Bearish','Candle.Engulfing.Bullish','Candle.Hammer','Candle.HangingMan','Candle.Harami.Bearish','Candle.Harami.Bullish','Candle.InvertedHammer','Candle.Kicking.Bearish','Candle.Kicking.Bullish','Candle.LongShadow.Lower','Candle.LongShadow.Upper','Candle.Marubozu.Black','Candle.Marubozu.White','Candle.ShootingStar','Candle.SpinningTop.Black','Candle.SpinningTop.White','Candle.TriStar.Bearish','Candle.TriStar.Bullish','Candle.3WhiteSoldiers','Candle.3BlackCrows','Candle.AbandonedBaby.Bullish','Candle.AbandonedBaby.Bearish'];

const BULL_CANDLES = ['Candle.Engulfing.Bullish','Candle.Hammer','Candle.InvertedHammer','Candle.Harami.Bullish','Candle.Kicking.Bullish','Candle.Marubozu.White','Candle.3WhiteSoldiers','Candle.AbandonedBaby.Bullish','Candle.TriStar.Bullish','Candle.Doji.Dragonfly'];
const BEAR_CANDLES = ['Candle.Engulfing.Bearish','Candle.HangingMan','Candle.Harami.Bearish','Candle.Kicking.Bearish','Candle.Marubozu.Black','Candle.3BlackCrows','Candle.AbandonedBaby.Bearish','Candle.TriStar.Bearish','Candle.ShootingStar','Candle.Doji.Gravestone'];

function label(rec) {
  return rec >= 0.5 ? 'STRONG BUY' : rec >= 0.1 ? 'BUY' : rec <= -0.5 ? 'STRONG SELL' : rec <= -0.1 ? 'SELL' : 'NEUTRAL';
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Fuse 122 raw TradingView metrics into one score in [-1,1] + readable breakdown.
function composite(d) {
  const c = d.close;
  const notes = [];
  // — trend: MA stack, ADX direction, SAR, Ichimoku, Hull, Aroon
  let trend = 0, above = 0, maN = 0;
  for (const k of ['EMA20','EMA50','EMA100','EMA200','SMA50','SMA200','VWMA','HullMA9','Ichimoku.BLine']) {
    if (d[k] != null) { maN++; if (c > d[k]) above++; }
  }
  if (maN) { trend += (above / maN) * 2 - 1; if (above / maN >= 0.8) notes.push(`above ${above}/${maN} MAs`); if (above / maN <= 0.2) notes.push(`below ${maN - above}/${maN} MAs`); }
  if (d.ADX != null && d.ADX > 20 && d['ADX+DI'] != null) {
    const dir = d['ADX+DI'] > d['ADX-DI'] ? 1 : -1;
    trend += dir * Math.min((d.ADX - 20) / 30, 0.8);
    if (d.ADX > 28) notes.push(`ADX ${d.ADX.toFixed(0)} ${dir > 0 ? 'up' : 'down'}trend`);
  }
  if (d['P.SAR'] != null) trend += c > d['P.SAR'] ? 0.25 : -0.25;
  if (d['Aroon.Up'] != null) trend += ((d['Aroon.Up'] - d['Aroon.Down']) / 100) * 0.4;
  trend = clamp(trend / 2.5, -1, 1);
  // — momentum: oscillators + MACD + money flow
  let mo = 0;
  if (d.RSI != null) { mo += d.RSI < 30 ? 0.5 : d.RSI > 70 ? -0.5 : (d.RSI - 50) / 40; if (d.RSI < 30) notes.push(`RSI ${d.RSI.toFixed(0)} oversold`); }
  if (d['Stoch.K'] != null && d['Stoch.D'] != null) { if (d['Stoch.K'] < 25 && d['Stoch.K'] > d['Stoch.D']) { mo += 0.4; notes.push('stoch turning up'); } else if (d['Stoch.K'] > 80) mo -= 0.2; }
  if (d.CCI20 != null) mo += d.CCI20 < -100 ? 0.3 : d.CCI20 > 100 ? Math.min((d.CCI20 - 100) / 300, 0.25) : 0;
  if (d['W.R'] != null && d['W.R'] < -80) mo += 0.2;
  if (d.UO != null) mo += (d.UO - 50) / 60;
  if (d.AO != null && d['AO[1]'] != null) mo += (d.AO > 0 ? 0.15 : -0.15) + (d.AO > d['AO[1]'] ? 0.15 : -0.1);
  if (d['MACD.macd'] != null && d['MACD.signal'] != null) { const x = d['MACD.macd'] > d['MACD.signal']; mo += x ? 0.3 : -0.3; if (x && d['MACD.macd'] < 0) notes.push('MACD curling up'); }
  if (d.Mom != null && d['Mom[1]'] != null && d.Mom > 0 && d.Mom > d['Mom[1]']) mo += 0.15;
  if (d.MoneyFlow != null) mo += d.MoneyFlow < 20 ? 0.25 : d.MoneyFlow > 80 ? -0.25 : 0;
  if (d.ChaikinMoneyFlow != null) mo += clamp(d.ChaikinMoneyFlow * 2, -0.25, 0.25);
  mo = clamp(mo / 2.2, -1, 1);
  // — levels: consensus across 4 pivot systems + Bollinger position
  let lv = 0, sys = 0;
  for (const s of ['Classic', 'Fibonacci', 'Camarilla', 'Woodie']) {
    const mid = d[`Pivot.M.${s}.Middle`], s1 = d[`Pivot.M.${s}.S1`], r1 = d[`Pivot.M.${s}.R1`];
    if (mid == null) continue;
    sys++;
    lv += c > mid ? 0.3 : -0.3;
    if (s1 != null && Math.abs(c - s1) / c < 0.004) { lv += 0.4; notes.push(`at ${s.toLowerCase()} S1 support`); }
    if (r1 != null && c > r1) lv += 0.2;
  }
  lv = sys ? clamp(lv / sys, -1, 1) : 0;
  if (d['BB.lower'] != null && d['BB.upper'] != null && d['BB.upper'] > d['BB.lower']) {
    const pctB = (c - d['BB.lower']) / (d['BB.upper'] - d['BB.lower']);
    if (pctB < 0.05) { lv += 0.3; notes.push('at lower Bollinger band'); }
    else if (pctB > 1) { lv -= 0.25; notes.push('above upper Bollinger'); }
    lv = clamp(lv, -1, 1);
  }
  // — candles: TradingView's own pattern detection
  let ca = 0;
  const bulls = BULL_CANDLES.filter(k => d[k]); const bears = BEAR_CANDLES.filter(k => d[k]);
  ca = clamp(bulls.length * 0.35 - bears.length * 0.35, -1, 1);
  for (const b of bulls.slice(0, 2)) notes.push(b.replace('Candle.', '').replace(/\./g, ' ').toLowerCase());
  for (const b of bears.slice(0, 1)) notes.push('⚠ ' + b.replace('Candle.', '').replace(/\./g, ' ').toLowerCase());
  // — 52-week structure
  let ex = 0;
  if (d.price_52_week_high != null && d.price_52_week_low != null && d.price_52_week_high > d.price_52_week_low) {
    const pos = (c - d.price_52_week_low) / (d.price_52_week_high - d.price_52_week_low);
    ex = pos > 0.85 ? 0.4 : pos < 0.12 ? -0.2 : 0;
    if (pos > 0.95) notes.push('near 52w high');
  }
  const score = clamp(0.40 * (d['Recommend.All'] || 0) + 0.16 * trend + 0.16 * mo + 0.10 * lv + 0.12 * ca + 0.06 * ex, -1, 1);
  const atrPct = d.ATR != null && c ? d.ATR / c : null;
  return { score, notes: notes.slice(0, 4), atrPct, beta: d.beta_1_year ?? null };
}

function start(bus) {
  bus.tvRatings = {};
  bus.tvHot = [];
  bus.tvaStatus = { rated: 0, matched: 0, lastMarket: null, updated: null, errors: 0, metricsPerSymbol: COLS.length };
  let idx = 0;

  async function fetchRows(mkt, sortOrder, count) {
    const body = {
      filter: [
        { left: 'type', operation: 'in_range', right: ['stock', 'fund'] },
        { left: 'exchange', operation: 'in_range', right: mkt.ex },
        { left: 'volume', operation: 'greater', right: 10000 },
      ],
      markets: [mkt.id],
      symbols: { query: { types: [] }, tickers: [] },
      columns: ['name', ...COLS],
      sort: { sortBy: 'Recommend.All', sortOrder },
      range: [0, count],
    };
    const r = await fetch(`https://scanner.tradingview.com/${mkt.id}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { bus.tvaStatus.errors++; return []; }
    const j = await r.json();
    return j.data || [];
  }

  async function scanMarket(mkt) {
    // desc window = strongest BUYs; asc window = strongest SELLs. Without the second,
    // a held name whose rating flips negative just falls out of the top-350 response,
    // so the STRONG-SELL protective exit (trader.js) could never fire.
    const rows = [...await fetchRows(mkt, 'desc', 350), ...await fetchRows(mkt, 'asc', 150)];
    const inUni = new Set(bus.universe.map(u => u.y));
    let matched = 0;
    for (const row of rows) {
      const d = {};
      row.d.forEach((v, i) => { d[i === 0 ? 'name' : COLS[i - 1]] = v; });
      const y = mkt.toY(d.name);
      if (!inUni.has(y)) continue;
      const { score, notes, atrPct, beta } = composite(d);
      bus.tvRatings[y] = { rec: +score.toFixed(3), raw: d['Recommend.All'], label: label(score),
        detail: notes.join(' · '), atrPct, beta, rsi: d.RSI, tvName: row.s, at: Date.now() };
      matched++;
    }
    bus.tvaStatus.lastMarket = mkt.id + ` (${matched} in universe)`;
    bus.tvaStatus.updated = new Date().toLocaleTimeString();
    const cutoff = Date.now() - 30 * 60e3;
    for (const [sym, v] of Object.entries(bus.tvRatings)) if (v.at < cutoff) delete bus.tvRatings[sym];
    bus.tvaStatus.rated = Object.keys(bus.tvRatings).length;
    bus.tvaStatus.matched = matched;
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
  console.log(`[tvanalyst] agent started — ${COLS.length} TradingView metrics/symbol across 8 markets`);
}
module.exports = { start };
