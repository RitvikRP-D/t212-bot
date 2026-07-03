'use strict';
// AGENT ⑭: HISTORIAN — the long-memory analyst. Pulls the ENTIRE monthly price
// history Yahoo holds for every symbol it studies (S&P 500 back to 1927 — near a
// century; Dow, FTSE, DAX, gold, oil similar) plus every current holding and
// hot signal. Computes: secular regime (price vs 10-month MA — the classic
// trend-following filter), long-run CAGR, worst drawdown, distance from all-time
// high. Verdicts boost or veto trader entries: never fight a century of trend.
const { HISTORY_MS } = require('../config');

const CORE = ['^GSPC', '^IXIC', '^DJI', '^FTSE', '^GDAXI', '^STOXX50E', 'GC=F', 'CL=F', 'BTC-USD', 'ETH-USD'];

function start(bus) {
  bus.longTerm = {};  // sym -> {regime, cagr, maxDD, offHigh, note, at}
  bus.histStatus = { analyzed: 0, errors: 0, cached: 0, lastSym: null, oldest: null };
  let idx = 0;

  function targets() {
    const t = [...CORE];
    t.push(...Object.keys(bus.state.t212.positions));
    for (const [sym, m] of Object.entries(bus.market)) if ((m.lastConf || 0) >= 0.5) t.push(sym);
    return [...new Set(t)];
  }

  async function analyze(sym) {
    const cached = bus.longTerm[sym];
    if (cached && Date.now() - cached.at < 24 * 3600e3) return; // refresh daily
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1mo&range=max`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' } });
      if (!r.ok) { bus.histStatus.errors++; return; }
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      const closes = (res?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      const ts = res?.timestamp;
      if (closes.length < 24) return;
      const c = closes[closes.length - 1];
      const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, closes.length);
      const years = ts ? (ts[ts.length - 1] - ts[0]) / (365.25 * 86400) : closes.length / 12;
      const cagr = years > 1 ? (Math.pow(c / closes[0], 1 / years) - 1) * 100 : null;
      let peak = closes[0], maxDD = 0, ath = Math.max(...closes);
      for (const x of closes) { if (x > peak) peak = x; maxDD = Math.max(maxDD, (peak - x) / peak); }
      const regime = c > ma10 ? 1 : -1;
      const yr12 = closes.length >= 13 ? (c / closes[closes.length - 13] - 1) * 100 : null;
      bus.longTerm[sym] = {
        regime, cagr: cagr != null ? +cagr.toFixed(1) : null,
        maxDD: +(maxDD * 100).toFixed(0), offHigh: +((1 - c / ath) * 100).toFixed(1),
        yr12: yr12 != null ? +yr12.toFixed(1) : null, years: +years.toFixed(0),
        note: `${years.toFixed(0)}y history: ${regime > 0 ? 'secular BULL (above 10-mo MA)' : 'secular BEAR (below 10-mo MA)'}${cagr != null ? `, ${cagr.toFixed(1)}%/yr` : ''}`,
        at: Date.now(),
      };
      bus.histStatus.analyzed++;
      bus.histStatus.lastSym = sym;
      bus.histStatus.cached = Object.keys(bus.longTerm).length;
      if (ts && (!bus.histStatus.oldest || years > bus.histStatus.oldest.y))
        bus.histStatus.oldest = { sym, y: +years.toFixed(0) };
    } catch (e) { bus.histStatus.errors++; }
  }

  setInterval(() => {
    const t = targets();
    if (t.length) analyze(t[idx++ % t.length]);
  }, HISTORY_MS);
  console.log('[history] long-memory analyst started — monthly data back to 1927 where it exists');
}
module.exports = { start };
