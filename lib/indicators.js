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
// Shared signal evaluation. mk needs {price, rsi, closes, crossUp}. Returns null or {conf, sigType, reasons}
function evaluate(mk, senti = 0, fng = null, learnMul = 1) {
  if (!mk || mk.price == null || mk.rsi == null) return null;
  let conf = 0, sigType = null; const reasons = [];
  if (mk.rsi < 40) {
    conf += 0.18 + (40 - mk.rsi) / 40 * 0.55;
    sigType = mk.rsi < 32 ? 'RSI_OVERSOLD' : 'RSI_DIP';
    reasons.push(`RSI ${mk.rsi.toFixed(1)} ${mk.rsi < 32 ? 'oversold' : 'dipping'}`);
  }
  if (mk.crossUp && mk.rsi < 65) { conf += 0.28; sigType = sigType || 'MACD_CROSS'; reasons.push('MACD crossed up'); }
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
  if (!sigType) return null;
  if (senti) { conf += senti * 0.08; reasons.push(`news ${senti > 0 ? '+' : ''}${senti}`); }
  if (fng != null) {
    if (fng <= 25) { conf += 0.08; reasons.push(`extreme fear ${fng} → contrarian`); }
    else if (fng >= 78) { conf -= 0.08; reasons.push(`greed ${fng} → caution`); }
  }
  if (learnMul !== 1) { conf *= learnMul; reasons.push(`learning ×${learnMul.toFixed(2)}`); }
  conf = Math.max(0, Math.min(1, conf));
  return { conf, sigType, reasons };
}
module.exports = { calcRSI, calcMACD, emaSeries, evaluate };
