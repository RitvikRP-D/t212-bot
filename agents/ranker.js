'use strict';
// AGENT ⑮: UNIVERSE RANKER — works through ALL ~16,000 tradable instruments in a
// slow background pass (weekly candles, 2 years) and keeps a living leaderboard:
// 6-month momentum, above/below 40-week MA, volatility quality. The top-150 set
// earns a conviction bonus in the trader; the bottom of the book gets avoided.
// Answers "of everything we CAN buy, what deserves capital?" for the whole fleet.
const { RANKER_MS } = require('../config');

function start(bus) {
  bus.rankTop = new Set();
  bus.rankScores = {};   // sym -> score
  bus.rankStatus = { scanned: 0, errors: 0, ranked: 0, lastSym: null, passPct: 0, leaders: [] };
  let idx = 0;

  async function rank(sym) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1wk&range=2y`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' } });
      if (r.status === 429) return; // yield to the 1-min scanner's rate budget
      if (!r.ok) { bus.rankStatus.errors++; return; }
      const j = await r.json();
      const closes = (j.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      if (closes.length < 30) return;
      const c = closes[closes.length - 1];
      const mom26 = closes.length >= 27 ? (c / closes[closes.length - 27] - 1) : 0;       // ~6-month momentum
      const ma40 = closes.slice(-40).reduce((a, b) => a + b, 0) / Math.min(40, closes.length);
      const rets = [];
      for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      const vol = Math.sqrt(rets.reduce((a, x) => a + x * x, 0) / rets.length);
      const score = mom26 * 2 + (c > ma40 ? 0.5 : -0.5) - Math.min(vol * 4, 0.8);
      bus.rankScores[sym] = +score.toFixed(3);
      bus.rankStatus.scanned++;
      bus.rankStatus.lastSym = sym;
      // rebuild leaderboard every 50 rankings
      if (bus.rankStatus.scanned % 50 === 0) {
        const sorted = Object.entries(bus.rankScores).sort((a, b) => b[1] - a[1]);
        bus.rankTop = new Set(sorted.slice(0, 150).map(([s]) => s));
        bus.rankStatus.ranked = sorted.length;
        bus.rankStatus.passPct = +(sorted.length / Math.max(1, bus.universe.length) * 100).toFixed(1);
        bus.rankStatus.leaders = sorted.slice(0, 10).map(([s, v]) => `${s} ${v}`);
      }
    } catch (e) { bus.rankStatus.errors++; }
  }

  setInterval(() => {
    const uni = bus.universe;
    if (!uni.length) return;
    // priority: TV-hot names first so the leaderboard is useful immediately
    const hot = bus.tvHot || [];
    const sym = (bus.rankStatus.scanned % 4 === 0 && hot.length) ? hot[Math.floor(bus.rankStatus.scanned / 4) % hot.length] : uni[idx++ % uni.length].y;
    rank(sym);
  }, RANKER_MS);
  console.log('[ranker] whole-universe ranker started — grading all ~16k instruments in the background');
}
module.exports = { start };
