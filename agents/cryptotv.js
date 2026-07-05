'use strict';
// AGENT ⑪: CRYPTO TRADINGVIEW ANALYST — server-side, 24/7, no desktop app needed.
// Pulls TradingView's own computed technicals for the crypto board across SIX
// timeframes (15m, 1h, 4h, 1d, 1w + base), ~350 live metrics per coin —
// 30 coins × ~350 = ~10,500 TradingView metrics refreshed continuously.
// Fuses them into one [-1,1] score per coin that boosts/vetoes the crypto scanner.
const { CRYPTOTV_MS } = require('../config');

const BASE = ['Recommend.All','Recommend.MA','Recommend.Other','RSI','Stoch.K','Stoch.D','Stoch.RSI.K','CCI20','ADX','ADX+DI','ADX-DI','AO','Mom','MACD.macd','MACD.signal','W.R','UO','BBPower','EMA10','EMA20','EMA50','EMA100','EMA200','SMA10','SMA20','SMA50','SMA100','SMA200','HullMA9','VWMA','Ichimoku.BLine','P.SAR','BB.lower','BB.upper','ATR','Volatility.D','Aroon.Up','Aroon.Down','ROC','MoneyFlow','ChaikinMoneyFlow','close','change','volume','market_cap_calc','24h_vol_change|5'];
const TF_COLS = ['Recommend.All','RSI','Stoch.K','Stoch.D','CCI20','ADX','ADX+DI','ADX-DI','AO','Mom','MACD.macd','MACD.signal','W.R','UO','BBPower','EMA20','EMA50','EMA200','SMA20','SMA50','SMA200','P.SAR','BB.lower','BB.upper','Ichimoku.BLine','Stoch.RSI.K','ROC','Aroon.Up','Aroon.Down','MoneyFlow','HullMA9','VWMA','ATR','Volatility.D','CCI20[1]','RSI[1]','Stoch.K[1]','AO[1]','Mom[1]','MACD.signal[1]','ADX+DI[1]','ADX-DI[1]','Stoch.D[1]','Recommend.MA','Recommend.Other','change','UO[1]','BBPower[1]','W.R[1]','ROC[1]','Aroon.Up[1]'];
const TFS = ['|15', '|60', '|240', '', '|1W', '|1M'];
const COLS = [...new Set([...BASE, ...TFS.flatMap(tf => TF_COLS.map(c => c.includes('[') ? c : c + tf))])];
const COINS = new Set(['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','LINK','LTC','UNI','ATOM','XLM','ETC','FIL','APT','ARB','OP','NEAR','INJ','SUI','TIA','SEI','FET','RNDR','TON','TRX','SHIB','PEPE',
  'POL','ICP','HBAR','VET','ALGO','GRT','AAVE','MKR','RUNE','IMX','STX','WIF','BONK','FLOKI','JUP','PYTH','ONDO','ENA','LDO','CRV']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function label(rec) { return rec >= 0.5 ? 'STRONG BUY' : rec >= 0.1 ? 'BUY' : rec <= -0.5 ? 'STRONG SELL' : rec <= -0.1 ? 'SELL' : 'NEUTRAL'; }

// multi-timeframe fusion: short TFs time the entry, long TFs set the regime
function composite(d) {
  const notes = [];
  let score = 0, n = 0;
  const W = { '|15': 0.10, '|60': 0.20, '|240': 0.25, '': 0.25, '|1W': 0.15, '|1M': 0.05 };
  for (const tf of TFS) {
    const rec = d['Recommend.All' + tf];
    if (rec == null) continue;
    score += rec * (W[tf] || 0.1); n++;
  }
  if (!n) return null;
  const c = d.close;
  let extra = 0;
  for (const tf of ['|60', '|240', '']) {
    const rsi = d['RSI' + tf];
    if (rsi != null) { if (rsi < 30) { extra += 0.15; notes.push(`RSI${tf || '|1D'} ${rsi.toFixed(0)} oversold`); } else if (rsi > 75) extra -= 0.12; }
    const mac = d['MACD.macd' + tf], sig = d['MACD.signal' + tf];
    if (mac != null && sig != null) extra += mac > sig ? 0.06 : -0.06;
    const sar = d['P.SAR' + tf];
    if (sar != null && c != null) extra += c > sar ? 0.04 : -0.04;
  }
  let above = 0, mas = 0;
  for (const k of ['EMA50','EMA200','SMA50','SMA200','EMA50|240','EMA200|240','SMA50|1W','SMA200|1W']) {
    if (d[k] != null && c != null) { mas++; if (c > d[k]) above++; }
  }
  if (mas >= 4) { extra += (above / mas - 0.5) * 0.5; if (above === mas) notes.push(`above all ${mas} MAs (multi-TF)`); }
  const weeklyRec = d['Recommend.All|1W'];
  if (weeklyRec != null && weeklyRec > 0.3) notes.push('weekly trend bullish');
  if (weeklyRec != null && weeklyRec < -0.3) notes.push('⚠ weekly trend bearish');
  return { score: clamp(score + extra, -1, 1), notes: notes.slice(0, 3) };
}

function start(bus) {
  bus.tvCrypto = {};
  bus.ctvStatus = { rated: 0, errors: 0, metricsPerCoin: COLS.length, totalMetrics: 0, updated: null };

  async function scan() {
    const body = {
      filter: [
        { left: 'exchange', operation: 'in_range', right: ['BINANCE'] },
        { left: 'name', operation: 'match', right: 'USDT$' },
      ],
      markets: ['crypto'],
      columns: ['name', ...COLS],
      sort: { sortBy: 'market_cap_calc', sortOrder: 'desc' },
      range: [0, 120],
    };
    const r = await fetch('https://scanner.tradingview.com/crypto/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { bus.ctvStatus.errors++; return; }
    const j = await r.json();
    let rated = 0;
    for (const row of j.data || []) {
      const d = {};
      row.d.forEach((v, i) => { d[i === 0 ? 'name' : COLS[i - 1]] = v; });
      const coin = (d.name || '').replace(/USDT$/, '');
      if (!COINS.has(coin)) continue;
      const comp = composite(d);
      if (!comp) continue;
      bus.tvCrypto[coin] = { rec: +comp.score.toFixed(3), label: label(comp.score), detail: comp.notes.join(' · '), at: Date.now() };
      rated++;
    }
    bus.ctvStatus.rated = rated;
    bus.ctvStatus.totalMetrics = rated * COLS.length;
    bus.ctvStatus.updated = new Date().toLocaleTimeString();
  }

  setInterval(() => scan().catch(() => bus.ctvStatus.errors++), CRYPTOTV_MS);
  scan().catch(() => bus.ctvStatus.errors++);
  console.log(`[cryptoTV] 24/7 analyst started — ${COLS.length} TradingView metrics/coin × ${COINS.size} coins across 6 timeframes`);
}
module.exports = { start };
