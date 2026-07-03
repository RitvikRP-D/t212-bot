'use strict';
function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    g = (g * (p-1) + Math.max(d, 0)) / p;
    l = (l * (p-1) + Math.max(-d, 0)) / p;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function emaSeries(v, p) { const k = 2/(p+1); let e = v[0]; const out = [e]; for (let i = 1; i < v.length; i++) { e = v[i]*k + e*(1-k); out.push(e); } return out; }
function calcMACD(closes) {
  if (!closes || closes.length < 40) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const sig = emaSeries(line.slice(26), 9);
  const hNow = line[line.length-1] - sig[sig.length-1];
  const hPrev = line[line.length-2] - sig[sig.length-2];
  return { hist: hNow, crossUp: hPrev <= 0 && hNow > 0, crossDown: hPrev >= 0 && hNow < 0 };
}
// Extended per-candle metrics computed locally on 1-min OHLCV session data.
function extendedMetrics(opens, highs, lows, closes, vols) {
  const n = closes.length;
  if (n < 21) return {};
  const out = {};
  // session VWAP
  let pv = 0, vv = 0;
  for (let i = 0; i < n; i++) { const tp = (highs[i] + lows[i] + closes[i]) / 3; pv += tp * (vols[i] || 0); vv += vols[i] || 0; }
  out.vwap = vv > 0 ? pv / vv : null;
  // Bollinger %B (20, 2)
  const w = closes.slice(-20), mean = w.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
  out.pctB = sd > 0 ? (closes[n-1] - (mean - 2 * sd)) / (4 * sd) : null;
  // Stochastic %K (14)
  const hh = Math.max(...highs.slice(-14)), ll = Math.min(...lows.slice(-14));
  out.stochK = hh > ll ? (closes[n-1] - ll) / (hh - ll) * 100 : null;
  // ATR(14) as % of price
  let atr = 0;
  for (let i = n - 14; i < n; i++) atr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  out.atrPct = (atr / 14) / closes[n-1];
  // volume surge vs prior 20-candle average
  const va = vols.slice(-21, -1).reduce((a, b) => a + (b || 0), 0) / 20;
  out.volSurge = va > 0 ? (vols[n-1] || 0) / va : null;
  // candle patterns on the last 3 completed candles
  const bull = [], bear = [];
  const B = i => Math.abs(closes[i] - opens[i]), R = i => highs[i] - lows[i] || 1e-9;
  const up = i => highs[i] - Math.max(opens[i], closes[i]), dn = i => Math.min(opens[i], closes[i]) - lows[i];
  const g = i => closes[i] > opens[i], r = i => closes[i] < opens[i];
  const L = n - 1, P = n - 2;
  if (B(L) < 0.15 * R(L)) bull.push('doji (indecision)');
  if (dn(L) > 2 * B(L) && up(L) < B(L) && closes[P] < opens[P]) bull.push('hammer');
  if (up(L) > 2 * B(L) && dn(L) < B(L) && g(P)) bear.push('shooting star');
  if (r(P) && g(L) && opens[L] <= closes[P] && closes[L] >= opens[P] && B(L) > B(P)) bull.push('bullish engulfing');
  if (g(P) && r(L) && opens[L] >= closes[P] && closes[L] <= opens[P] && B(L) > B(P)) bear.push('bearish engulfing');
  if (g(L) && B(L) > 0.85 * R(L)) bull.push('marubozu');
  if (n >= 4 && g(L) && g(P) && g(n-3) && closes[L] > closes[P] && closes[P] > closes[n-3]) bull.push('three white soldiers');
  if (n >= 4 && r(L) && r(P) && r(n-3) && closes[L] < closes[P] && closes[P] < closes[n-3]) bear.push('three black crows');
  out.bullPatterns = bull; out.bearPatterns = bear;
  return out;
}
// Shared signal evaluation. mk needs {price, rsi, closes, crossUp}. Returns null or {conf, sigType, reasons}
function evaluate(mk, senti = 0, fng = null, learnMul = 1) {
  if (!mk || mk.price == null || mk.rsi == null) return null;
  let conf = 0, sigType = null; const reasons = [];
  if (mk.rsi < 50) {
    conf += 0.30 + (50 - mk.rsi) / 50 * 0.70;
    sigType = mk.rsi < 30 ? 'RSI_OVERSOLD' : 'RSI_DIP';
    reasons.push(`RSI ${mk.rsi.toFixed(1)} ${mk.rsi < 30 ? 'OVERSOLD' : 'dipping'}`);
  }
  if (mk.crossUp && mk.rsi < 70) { conf += 0.35; sigType = sigType || 'MACD_CROSS'; reasons.push('MACD crossed up (strong)'); }
  const cl = mk.closes;
  if (cl && cl.length >= 31) {
    const chg15 = (cl[cl.length-1] - cl[cl.length-16]) / cl[cl.length-16];
    if (chg15 < -0.012 && cl[cl.length-1] > cl[cl.length-2]) {
      conf += 0.22; sigType = sigType || 'DIP_REVERSAL';
      reasons.push(`fell ${(chg15*100).toFixed(1)}% in 15m, turning up`);
    }
    const hi30 = Math.max(...cl.slice(-31, -1));
    if (cl[cl.length-1] > hi30 && mk.rsi < 72) {
      conf += 0.20; sigType = sigType || 'BREAKOUT';
      reasons.push('broke 30-min high');
    }
  }
  if (mk.pctB != null && mk.pctB < 0.05 && cl && cl[cl.length-1] > cl[cl.length-2]) {
    conf += 0.15; sigType = sigType || 'BB_BOUNCE'; reasons.push('at lower Bollinger band, turning up');
  }
  if (mk.vwap != null && cl && cl.length >= 2 && cl[cl.length-2] < mk.vwap && mk.price > mk.vwap && (mk.volSurge || 0) > 1.5) {
    conf += 0.18; sigType = sigType || 'VWAP_RECLAIM'; reasons.push(`reclaimed VWAP on ${mk.volSurge.toFixed(1)}× volume`);
  }
  if (mk.stochK != null && mk.stochK < 20 && cl && cl[cl.length-1] > cl[cl.length-2]) { conf += 0.10; reasons.push(`stochastic ${mk.stochK.toFixed(0)} oversold`); }
  if (mk.bullPatterns && mk.bullPatterns.length && sigType) {
    conf += Math.min(0.15, mk.bullPatterns.length * 0.06);
    reasons.push('candles: ' + mk.bullPatterns.slice(0, 2).join(', '));
  }
  if (mk.bearPatterns && mk.bearPatterns.length >= 2) { conf -= 0.15; reasons.push('⚠ bearish candles: ' + mk.bearPatterns.join(', ')); }
  if (!sigType) return null;
  if ((mk.volSurge || 0) > 1.8) { conf *= 1.12; reasons.push(`volume surge ${mk.volSurge.toFixed(1)}×`); }
  if (senti) { conf += senti * 0.08; reasons.push(`news ${senti > 0 ? '+' : ''}${senti}`); }
  if (fng != null) {
    if (fng <= 25) { conf += 0.08; reasons.push(`extreme fear ${fng} → contrarian`); }
    else if (fng >= 78) { conf -= 0.08; reasons.push(`greed ${fng} → caution`); }
  }
  if (learnMul !== 1) { conf *= learnMul; reasons.push(`learning ×${learnMul.toFixed(2)}`); }
  conf = Math.max(0, Math.min(1, conf));
  return { conf, sigType, reasons };
}
module.exports = { calcRSI, calcMACD, emaSeries, evaluate, extendedMetrics };
