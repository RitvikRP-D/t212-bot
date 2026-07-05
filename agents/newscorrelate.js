'use strict';
// AGENT: NEWS CORRELATOR — the "what does this actually MEAN for a stock" engine.
// Runs on a fast tick (every ~2s) and, for every fresh headline from the News Radar,
// works out: (1) WHICH instruments it touches — by direct company-name mention and by
// sector/theme, (2) WHICH WAY it should push them (direction), (3) HOW STRONGLY, and
// (4) WHY — in one plain-English line. Crucially it cross-checks each call against the
// live TradingView technical rating for that name, so the output isn't "news says up"
// in a vacuum — it's "news says up AND the chart agrees / disagrees", which is a far
// better-educated signal for the trader.
//
// Publishes:
//   bus.newsCorrelations = [{ sym, name, headline, source, sentiment, tv, direction,
//                             strength, why, at }]   ← the human-readable feed
//   bus.newsImpact[sym]   = bounded −1..+1 conviction   ← what the trader folds in
const { NAMES, venue, marketOpen } = require('../config');
const { sectorOf } = require('../lib/fleet');

const TICK_MS = 2000;           // fast re-correlation cadence
const HEADLINE_TTL = 45 * 60e3; // a headline stays "active" for 45 min, then decays out

// Sector/theme keyword → which sectors it hits and the sign a NEGATIVE story implies.
// (positive story flips the sign.) Used when no single company is named.
const THEMES = {
  rates:    { re: /rate (cut|hike|decision)|federal reserve|\bfomc\b|inflation|\bcpi\b|powell|yields?/i, hits: { tech: -1, reit: -1, finance: +1 }, note: 'rates repricing growth vs banks' },
  tariff:   { re: /tariff|trade war|import tax|export ban|customs duty/i, hits: { tech: -1, auto: -1, semis: -1, industrials: -1, materials: +1 }, note: 'tariffs squeeze importers & supply chains' },
  oil:      { re: /\bopec\b|crude|brent|oil price|barrel|oil output/i, hits: { energy: +1, airlines: -1, travel: -1 }, note: 'oil move: producers vs fuel-burners' },
  war:      { re: /\bwar\b|missile|invasion|military strike|sanctions|geopolit/i, hits: { energy: +1, defense: +1, gold: +1, airlines: -1, travel: -1 }, note: 'conflict = safety bid + energy/defence' },
  ai:       { re: /artificial intelligence|\bAI\b|chip demand|data ?cent(er|re)|semiconductor/i, hits: { semis: +1, tech: +1 }, note: 'AI capex → chips & software' },
  crypto:   { re: /bitcoin|ethereum|\bcrypto\b|\bBTC\b|\bETH\b|digital asset/i, hits: { crypto: +1, finance: +1 }, note: 'crypto risk-appetite proxy' },
  china:    { re: /\bchina\b|beijing|\bPBOC\b|\byuan\b|hang seng/i, hits: { materials: +1, semis: -1, auto: -1 }, note: 'China demand & supply-chain exposure' },
  recession:{ re: /recession|slowdown|hard landing|layoffs?|contraction|jobless/i, hits: { utilities: +1, consumer: +1, health: +1, auto: -1, airlines: -1, industrials: -1 }, note: 'defensives beat cyclicals in a slowdown' },
  earnings: { re: /earnings|guidance|profit warning|beats estimates|misses estimates|revenue/i, hits: {}, note: 'earnings catalyst' },
};

function start(bus) {
  bus.newsCorrelations = [];
  bus.newsImpact = {};
  bus.newsCorrStatus = { active: 0, tracked: 0, updated: null, withTV: 0 };

  // ―― build a name→symbol matcher (rebuilt when the universe/tracked set changes) ――
  let matcher = [];          // [{ sym, name, re }]
  let matcherKey = '';
  let bySector = {};         // sector -> [matcher entries] (theme/macro propagation)
  let lastAt = 0;            // newest headline timestamp already processed (incremental)
  let rolling = [];          // rolling correlations list (dedup by sym+headline)
  const GENERIC = /^(the|inc|corp|group|plc|ltd|co|holdings|company|international|global|and|&)$/i;

  function rebuildMatcher() {
    // relevant set = curated majors + everything we actively track (market/held/hot).
    // Keeps matching fast and focused on names we can actually trade.
    const tracked = new Set([
      ...Object.keys(NAMES),
      ...Object.keys(bus.market || {}),
      ...Object.keys(bus.state.t212.positions || {}),
      ...(bus.tvHot || []),
      ...((bus.newsRadar && bus.newsRadar.trumpAssets && bus.newsRadar.trumpAssets.syms) || []),  // his holdings always tracked
    ]);
    // EXPAND coverage far beyond the ~89 actively-scanned names: pull in the conviction
    // leaderboard + a broad slice of the 16k universe so news about ANY major listed
    // company is detected, not just a handful. Capped so matching stays fast.
    const ranked = bus.rankScores ? Object.keys(bus.rankScores).sort((a, b) => bus.rankScores[b] - bus.rankScores[a]) : [];
    for (const s of ranked) { if (tracked.size >= 1200) break; tracked.add(s); }
    if (tracked.size < 400) for (const u of (bus.universe || [])) { if (tracked.size >= 900) break; tracked.add(u.y); }
    const key = [...tracked].sort().join(',').slice(0, 500) + ':' + tracked.size;
    if (key === matcherKey) return;
    matcherKey = key;
    const uni = new Map((bus.universe || []).map(u => [u.y, u.name]));
    const built = [];
    for (const sym of tracked) {
      const raw = NAMES[sym] || uni.get(sym) || sym.split('.')[0];
      // build alternation of the distinctive name tokens (Apple, Nvidia, JPMorgan…)
      const alts = String(raw).split('|').map(s => s.trim())
        .map(s => s.replace(/\b(inc|corp|plc|ltd|co|group|holdings|sa|nv|ag)\b\.?/gi, '').trim())
        .filter(s => s.length >= 3 && !GENERIC.test(s));
      if (!alts.length) continue;
      try {
        const re = new RegExp('\\b(' + alts.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
        built.push({ sym, name: alts[0], re });
      } catch (e) { /* skip un-compilable names */ }
    }
    matcher = built;
    // sector index so theme/macro stories hit only the TOP few names per sector (not all)
    bySector = {};
    for (const m of built) { const s = sectorOf(m.sym); (bySector[s] = bySector[s] || []).push(m); }
    bus.newsCorrStatus.tracked = built.length;
  }

  function tvFor(sym) {
    const r = bus.tvRatings && bus.tvRatings[sym];
    if (r) return { rec: r.rec, label: r.label, src: 'chart' };
    const c = bus.tvCrypto && bus.tvCrypto[sym];
    if (c) return { rec: c.rec, label: c.label, src: 'chart' };
    return null;
  }

  function dirWord(v) { return v > 0.15 ? 'UP' : v < -0.15 ? 'DOWN' : 'FLAT'; }

  function correlate() {
    if (bus.beat) bus.beat('newscorrelate');
    const radar = bus.newsRadar;
    if (!radar || !radar.headlines || !radar.headlines.length) return;
    rebuildMatcher();

    const now = Date.now();
    // INCREMENTAL: only process headlines newer than the last we handled. This is what
    // makes it truly LIVE (each story correlated the moment it lands) and kills the lag
    // from re-scanning the whole 6h window against the matcher every 2 seconds.
    const fresh = radar.headlines.filter(h => (h.at || 0) > lastAt);
    if (radar.headlines.length) lastAt = Math.max(lastAt, ...radar.headlines.map(h => h.at || 0));
    let withTV = 0;

    const out = [];
    const push = (sym, name, h, base, why) => {
      const tv = tvFor(sym);
      let strength = base, tvNote = '';
      if (tv) { withTV++; const agree = Math.sign(tv.rec) === Math.sign(base); strength = base * (agree ? 1.25 : 0.6);
        tvNote = ` · chart ${tv.label}(${tv.rec > 0 ? '+' : ''}${tv.rec}) ${agree ? 'AGREES' : 'DISAGREES'}`; }
      strength = Math.max(-1, Math.min(1, strength));
      out.push({ sym, name, headline: h.title.slice(0, 140), url: h.url || '', source: h.source,
        sentiment: h.score, tv: tv ? tv.label : null, direction: dirWord(strength),
        strength: +strength.toFixed(2), open: marketOpen(sym), why: `${why}${tvNote}`, at: h.at || now });
    };

    for (const h of fresh) {
      if (Math.abs(h.score) < 0.1 && !(h.entities && h.entities.length)) continue;
      let named = false;
      for (const m of matcher) {
        if (m.re.test(h.title)) { named = true; push(m.sym, m.name, h, h.score * 0.85, `directly names ${m.name} (${h.source})`); }
      }
      // theme/macro propagation — hit only the TOP few names per affected sector (bounded)
      if (!named) {
        for (const [tname, t] of Object.entries(THEMES)) {
          if (!t.re.test(h.title)) continue;
          for (const [sec, sign] of Object.entries(t.hits))
            for (const m of (bySector[sec] || []).slice(0, 4))
              push(m.sym, m.name, h, h.score * sign * 0.4, `${tname} story → ${t.note} (${h.source})`);
        }
      }
    }

    // merge fresh into the rolling list, drop expired, cap; newest-strongest first
    rolling = [...out, ...rolling].filter(c => (now - c.at) < HEADLINE_TTL).slice(0, 400);

    // per-symbol live impact = mean strength across the rolling window
    const acc = {};
    for (const c of rolling) (acc[c.sym] = acc[c.sym] || []).push(c.strength);
    const impact = {};
    for (const [sym, arr] of Object.entries(acc)) impact[sym] = +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
    bus.newsImpact = impact;

    const sorted = [...rolling].sort((a, b) => (b.at - a.at) || (Math.abs(b.strength) - Math.abs(a.strength)));
    bus.newsCorrelations = sorted.slice(0, 160);
    bus.newsCorrStatus = { active: rolling.length, distinct: Object.keys(acc).length, tracked: matcher.length, withTV, updated: new Date().toLocaleTimeString() };
  }

  setInterval(correlate, TICK_MS);
  setTimeout(correlate, 8000);
  console.log('[newscorrelate] correlation engine armed — every headline → affected stocks + direction + why, cross-checked vs TradingView charts (2s tick)');
}
module.exports = { start };
