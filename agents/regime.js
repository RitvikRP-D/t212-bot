'use strict';
// AGENT ㉑: REGIME + VOLATILITY DETECTOR. Classifies the current tape as TREND / CHOP /
// SHOCK from a basket of liquid index/mega-cap proxies, and measures realized volatility
// vs its own recent norm. Publishes bus.regime = { state, vol, volRatio, mult:{conf,size,stop}}
// which the trader multiplies into confidence, position size and stop width:
//   • TREND  → favour breakouts, normal size, slightly wider stops (let winners run)
//   • CHOP   → reversals only, smaller size, tighter targets, higher conf bar
//   • SHOCK  → vol spiked hard → pause new entries until it settles (auto-clears)
const PROXIES = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'IWM', 'DIA', 'AMZN', 'META', 'GOOGL'];

function stdev(a) { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }

function start(bus) {
  bus.regime = { state: 'unknown', vol: 0, volRatio: 1, mult: { conf: 1, size: 1, stop: 1 }, breadth: 0, updated: null, stateChanged: false };
  let volHist = [];   // rolling recent realized-vol readings to compare against
  let prevState = 'unknown';   // #new⑤: track for regime shift detection

  function cycle() {
    if (bus.beat) bus.beat('regime');   // loop is alive even when markets are closed / no data yet
    const avail = PROXIES.map(s => bus.market[s]).filter(m => m && m.closes && m.closes.length >= 30);
    if (!avail.length) return;
    // realized 1-min vol across proxies (annualised-ish, just used as a relative gauge)
    let volSum = 0, trendVotes = 0, up = 0;
    for (const m of avail) {
      const c = m.closes.slice(-30), rets = [];
      for (let i = 1; i < c.length; i++) rets.push((c[i] - c[i - 1]) / c[i - 1]);
      volSum += stdev(rets);
      // trend vote: price clearly above/below its own 30-bar mean and RSI persistent
      const mean = c.reduce((a, b) => a + b, 0) / c.length;
      const dev = (c[c.length - 1] - mean) / mean;
      if (Math.abs(dev) > 0.004 && ((m.rsi > 55 && dev > 0) || (m.rsi < 45 && dev < 0))) trendVotes++;
      if (dev > 0) up++;
    }
    const vol = volSum / avail.length;
    volHist.push(vol); volHist = volHist.slice(-120);
    const base = volHist.length >= 10 ? volHist.slice(0, -1).reduce((a, b) => a + b, 0) / (volHist.length - 1) : vol;
    const volRatio = base > 0 ? vol / base : 1;
    const breadth = up / avail.length;                 // fraction of proxies above their mean
    const trendFrac = trendVotes / avail.length;

    let stateNow;
    if (volRatio > 2.2) stateNow = 'shock';
    else if (trendFrac >= 0.4) stateNow = 'trend';
    else stateNow = 'chop';

    const mult = stateNow === 'trend' ? { conf: 1.0, size: 1.0, stop: 1.15 }
      : stateNow === 'chop' ? { conf: 0.9, size: 0.8, stop: 0.85 }
        : { conf: 0.0, size: 0.5, stop: 0.8 };          // shock: conf×0 blocks new entries

    // #new⑤: INTRA-DAY REGIME SHIFT DETECTION — if state flips, tighten all open stops
    const stateChanged = stateNow !== prevState && prevState !== 'unknown';
    if (stateChanged) console.log(`[regime] SHIFT ${prevState} → ${stateNow} — tightening all open stops`);
    prevState = stateNow;

    bus.regime = { state: stateNow, vol: +(vol * 100).toFixed(3), volRatio: +volRatio.toFixed(2), mult, breadth: +breadth.toFixed(2), trendFrac: +trendFrac.toFixed(2), updated: new Date().toLocaleTimeString(), stateChanged };
  }
  setInterval(cycle, 20e3);
  setTimeout(cycle, 12e3);
  console.log('[regime] market-regime + volatility detector armed');
}
module.exports = { start };
