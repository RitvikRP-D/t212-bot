'use strict';
// AGENT: TRUMP TRADING DESK — a dedicated intelligence hub for the single most
// market-moving actor on earth. It does NOT blindly follow him; it builds a structured,
// tradeable read from four real, free signals and lets the fleet weigh it like any other:
//   1) a curated, direction-AWARE map of Trump-linked equities (who benefits, who gets
//      hurt under his policy) — grounded in well-documented market behaviour
//   2) his own posts (Truth Social) + official White House presidential actions + every
//      outlet quoting him (the radar's Trump lane) → which policy themes are hot right now
//   3) congressional trades (the free house-stock-watcher dataset) intersected with the
//      Trump-linked map → "politicians are buying these Trump names"
//   4) Quiver Quantitative, IF a key is present (agents/quiver.js) → gov contracts + more
// Output: bus.trump (dashboard board) + bus.trumpSignal[sym] (bounded advisory vote).
const { sectorOf } = require('../lib/fleet');

const TICK_MS = 30000;

// ── Curated Trump-linked equity map. sign +1 = benefits under Trump policy, −1 = hurt.
// cat groups them for the dashboard. Each is a REAL, documented linkage.
const MAP = [
  // Direct / family
  { sym: 'DJT', name: 'Trump Media & Technology', cat: 'Direct / family', sign: 1, why: 'he is the majority owner (Truth Social)' },
  { sym: 'COIN', name: 'Coinbase', cat: 'Direct / family', sign: 1, why: 'family crypto ventures (World Liberty Financial, $TRUMP) + pro-crypto policy' },
  { sym: 'MSTR', name: 'MicroStrategy', cat: 'Direct / family', sign: 1, why: 'largest corporate bitcoin holder — proxy for his crypto stance' },
  // Energy — "drill, baby, drill"
  { sym: 'XOM', name: 'Exxon Mobil', cat: 'Energy (drill-baby-drill)', sign: 1, why: 'deregulation + expanded drilling leases' },
  { sym: 'CVX', name: 'Chevron', cat: 'Energy (drill-baby-drill)', sign: 1, why: 'fossil-fuel-friendly policy' },
  { sym: 'OXY', name: 'Occidental', cat: 'Energy (drill-baby-drill)', sign: 1, why: 'US shale beneficiary' },
  { sym: 'COP', name: 'ConocoPhillips', cat: 'Energy (drill-baby-drill)', sign: 1, why: 'expanded federal drilling' },
  { sym: 'HAL', name: 'Halliburton', cat: 'Energy (drill-baby-drill)', sign: 1, why: 'more wells = more services' },
  // Defense — higher military spend
  { sym: 'LMT', name: 'Lockheed Martin', cat: 'Defense', sign: 1, why: 'rising defence budgets + arms deals' },
  { sym: 'RTX', name: 'RTX (Raytheon)', cat: 'Defense', sign: 1, why: 'missile/defence procurement' },
  { sym: 'NOC', name: 'Northrop Grumman', cat: 'Defense', sign: 1, why: 'nuclear/defence spend' },
  { sym: 'GD', name: 'General Dynamics', cat: 'Defense', sign: 1, why: 'defence + border contracts' },
  { sym: 'PLTR', name: 'Palantir', cat: 'Defense', sign: 1, why: 'government/defence data contracts, Trump-aligned founders' },
  // Immigration enforcement / private prisons — historically spike on his policy
  { sym: 'GEO', name: 'GEO Group', cat: 'Immigration enforcement', sign: 1, why: 'private-prison/detention beneficiary of hardline immigration policy' },
  { sym: 'CXW', name: 'CoreCivic', cat: 'Immigration enforcement', sign: 1, why: 'detention-capacity beneficiary' },
  { sym: 'AXON', name: 'Axon Enterprise', cat: 'Immigration enforcement', sign: 1, why: 'law-enforcement / border tech' },
  // Domestic steel / tariffs
  { sym: 'NUE', name: 'Nucor', cat: 'Tariffs / domestic steel', sign: 1, why: 'steel tariffs protect domestic producers' },
  { sym: 'STLD', name: 'Steel Dynamics', cat: 'Tariffs / domestic steel', sign: 1, why: 'tariff-protected domestic steel' },
  { sym: 'CLF', name: 'Cleveland-Cliffs', cat: 'Tariffs / domestic steel', sign: 1, why: 'US steel tariff beneficiary' },
  // Crypto miners / brokers — pro-crypto regime
  { sym: 'MARA', name: 'Marathon Digital', cat: 'Crypto policy', sign: 1, why: 'friendlier crypto regulation' },
  { sym: 'RIOT', name: 'Riot Platforms', cat: 'Crypto policy', sign: 1, why: 'bitcoin-mining, pro-crypto policy' },
  { sym: 'HOOD', name: 'Robinhood', cat: 'Crypto policy', sign: 1, why: 'crypto-trading volumes + lighter regulation' },
  // Deregulation banks
  { sym: 'GS', name: 'Goldman Sachs', cat: 'Deregulation banks', sign: 1, why: 'lighter financial regulation' },
  { sym: 'JPM', name: 'JPMorgan', cat: 'Deregulation banks', sign: 1, why: 'deregulation + M&A pickup' },
  // Quantum & AI (policy/executive-order driven — e.g. a quantum or chips push)
  { sym: 'IONQ', name: 'IonQ', cat: 'Quantum & AI policy', sign: 1, why: 'quantum-computing pure-play — spikes on federal quantum initiatives' },
  { sym: 'RGTI', name: 'Rigetti Computing', cat: 'Quantum & AI policy', sign: 1, why: 'quantum hardware — gov/defence quantum funding beneficiary' },
  { sym: 'QBTS', name: 'D-Wave Quantum', cat: 'Quantum & AI policy', sign: 1, why: 'quantum annealing — policy/announcement sensitive' },
  { sym: 'QUBT', name: 'Quantum Computing Inc', cat: 'Quantum & AI policy', sign: 1, why: 'small-cap quantum — high beta to quantum headlines' },
  { sym: 'NVDA', name: 'Nvidia', cat: 'Quantum & AI policy', sign: 1, why: 'AI/chips leader — CHIPS-Act & AI-order beneficiary (tariff risk cuts both ways)' },
  // Musk / ally
  { sym: 'TSLA', name: 'Tesla', cat: 'Musk / ally', sign: 1, why: 'Musk alliance, though EV-subsidy cuts cut both ways' },
  // HURT under Trump — clean energy / EV-subsidy dependent
  { sym: 'ICLN', name: 'iShares Clean Energy', cat: 'Clean energy (headwind)', sign: -1, why: 'IRA/subsidy rollback risk under Trump' },
  { sym: 'ENPH', name: 'Enphase', cat: 'Clean energy (headwind)', sign: -1, why: 'solar-subsidy exposure' },
  { sym: 'FSLR', name: 'First Solar', cat: 'Clean energy (headwind)', sign: -1, why: 'solar policy headwind (partly offset by tariffs on imports)' },
  { sym: 'RUN', name: 'Sunrun', cat: 'Clean energy (headwind)', sign: -1, why: 'residential-solar subsidy risk' },
  { sym: 'PLUG', name: 'Plug Power', cat: 'Clean energy (headwind)', sign: -1, why: 'hydrogen-subsidy dependence' },
];

// Policy themes we detect in his posts/news → which map categories they light up.
const THEMES = {
  energy:      { re: /drill|oil|crude|fossil|pipeline|energy independence|\bLNG\b|gas lease/i, cats: ['Energy (drill-baby-drill)'] },
  defense:     { re: /defen[cs]e|military|nato|arms|missile|troops|war|border wall/i, cats: ['Defense'] },
  crypto:      { re: /crypto|bitcoin|\bBTC\b|digital asset|stablecoin|strategic reserve/i, cats: ['Direct / family', 'Crypto policy'] },
  tariff:      { re: /tariff|trade deal|trade war|import|\bchina\b|steel|aluminium|aluminum/i, cats: ['Tariffs / domestic steel'] },
  immigration: { re: /immigration|border|deport|\bICE\b|migrant|asylum/i, cats: ['Immigration enforcement'] },
  dereg:       { re: /deregulat|red tape|wall street|banks?\b|rollback/i, cats: ['Deregulation banks'] },
  quantum:     { re: /quantum|artificial intelligence|\bAI\b|chips? act|semiconductor|supercomput/i, cats: ['Quantum & AI policy'] },
  cleanhit:    { re: /green new deal|climate|solar|\bEV\b|electric vehicle|subsid/i, cats: ['Clean energy (headwind)'] },
};

// ── STANDING PLAYBOOK — four years of his documented interviews, rallies, pressers and
// executive actions (2022→2026) distilled into a baseline intensity per theme. These are
// positions he has repeated in interview after interview: universal tariffs & China
// hawkishness, a pro-crypto/strategic-reserve stance, drill-baby-drill energy policy,
// higher defence spend / NATO burden-shifting, hardline immigration enforcement,
// financial deregulation, federal quantum/AI/chips pushes, and hostility to EV/solar
// subsidies. The floor keeps the desk positioned on his KNOWN agenda even in a quiet
// news hour; live headlines/speeches can only raise it, never fully erase it.
const PLAYBOOK = { tariff: 0.45, crypto: 0.40, energy: 0.40, defense: 0.35, immigration: 0.35, dereg: 0.30, quantum: 0.25, cleanhit: 0.35 };
// his OWN words (interviews, pressers, speeches) move markets harder than reporting
const SPEECH_RE = /interview|press conference|news conference|presser|speech|remarks|address\b|rally|town hall|oval office|state of the union|says|tells|vows|pledges|warns|announces/i;
// scheduled/upcoming events — conferences, summits, signings he is about to hold
const SCHED_RE = /will (speak|meet|hold|sign|announce|visit|address)|to (speak|meet|hold|sign|announce|visit|address)|scheduled|upcoming|later today|this week|next week|tomorrow|summit|expected to/i;

function start(bus) {
  bus.trump = { owns: MAP, posts: [], speeches: [], events: [], policyThemes: {}, congressBuys: [], basket: null, signals: {}, narrative: 'gathering…', quiver: null, updated: null };
  bus.trumpSignal = {};
  const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

  // resolve a curated ticker to the actual T212 universe symbol (best-effort) so the
  // signal can reach the trader; returns the ticker itself if no match (display still works)
  function resolve(sym) {
    if (bus.market && bus.market[sym]) return sym;
    const uni = bus.universe || [];
    const hit = uni.find(u => u.y === sym || u.y.split(/[._]/)[0] === sym);
    return hit ? hit.y : sym;
  }

  function tick() {
    if (bus.beat) bus.beat('trumptrades');
    const radar = bus.newsRadar || {};
    const lane = [...(radar.trumpFeed || []), ...((radar.headlines || []).filter(h => h.source === 'WhiteHouse'))];

    // 1) POLICY THEMES — live intensity from his posts/news, with his OWN spoken words
    // (interviews/pressers/speeches — incl. today's conference) weighted extra, sitting
    // on top of the standing 4-year playbook floor so the desk is never blind.
    const themes = {};
    for (const [t, def] of Object.entries(THEMES)) {
      const hits = lane.filter(h => def.re.test(h.title));
      let live = 0;
      if (hits.length) {
        const speechHits = hits.filter(h => SPEECH_RE.test(h.title)).length;
        const mood = hits.reduce((a, h) => a + (h.score || 0), 0) / hits.length;
        live = 0.35 + hits.length * 0.08 + speechHits * 0.10 + mood * 0.3;
      }
      themes[t] = +clamp(Math.max(live, PLAYBOOK[t] || 0)).toFixed(2);
    }

    // 1b) SPEECH LANE + SCHEDULED EVENTS — what he said (latest interviews/conferences)
    // and what he is ABOUT to do; a scheduled event touching a theme warms it up NOW
    // so the fleet can pre-position instead of reacting after the move.
    bus.trump.speeches = lane.filter(h => SPEECH_RE.test(h.title)).slice(0, 10)
      .map(h => ({ source: h.source, title: h.title, url: h.url || '', at: h.at, score: h.score }));
    bus.trump.events = lane.filter(h => SCHED_RE.test(h.title)).slice(0, 8).map(h => ({
      source: h.source, title: h.title, url: h.url || '', at: h.at,
      themes: Object.entries(THEMES).filter(([, d]) => d.re.test(h.title)).map(([t]) => t),
    }));
    for (const ev of bus.trump.events) for (const t of ev.themes) themes[t] = +clamp(themes[t] + 0.1).toFixed(2);

    // 2) SIGNALS per curated name = base sign × (floor + theme intensity), + direct mentions
    const signals = {}, resolvedSig = {};
    for (const m of MAP) {
      let s = 0; const reasons = [];
      // policy-theme contribution
      for (const [t, def] of Object.entries(THEMES)) {
        if (def.cats.includes(m.cat) && themes[t]) { s += m.sign * themes[t] * 0.6; reasons.push(`${t} theme hot (${themes[t]})`); }
      }
      // direct mention of the company in his lane
      const named = lane.find(h => new RegExp('\\b' + m.name.split(/[ (]/)[0] + '\\b', 'i').test(h.title) || new RegExp('\\b' + m.sym + '\\b').test(h.title));
      if (named) { s += m.sign * 0.4 + (named.score || 0) * 0.2; reasons.push(`named in "${named.title.slice(0, 48)}"`); }
      // baseline lean so the map is never all-zero (small, so it can't force a trade)
      if (!reasons.length) { s = m.sign * 0.12; reasons.push('standing policy linkage'); }
      const score = +clamp(s).toFixed(2);
      signals[m.sym] = { score, reasons, sign: m.sign, cat: m.cat };
      resolvedSig[resolve(m.sym)] = score;
    }
    bus.trump.signals = signals;
    bus.trumpSignal = resolvedSig;

    // 3) CONGRESS buys in Trump-linked names (free house-stock-watcher via bus.news)
    const linkedSyms = new Set(MAP.map(m => m.sym));
    const congress = bus.news && bus.news.congress ? bus.news.congress : [];
    const buyMap = {};
    for (const c of congress) {
      const tk = (c.ticker || '').toUpperCase();
      if (!linkedSyms.has(tk)) continue;
      if (!/purchase|buy/i.test(c.type || '')) continue;
      (buyMap[tk] = buyMap[tk] || { sym: tk, name: (MAP.find(m => m.sym === tk) || {}).name, count: 0, reps: new Set() });
      buyMap[tk].count++; buyMap[tk].reps.add(c.representative);
    }
    bus.trump.congressBuys = Object.values(buyMap).map(b => ({ sym: b.sym, name: b.name, count: b.count, reps: [...b.reps].slice(0, 4) }))
      .sort((a, b) => b.count - a.count).slice(0, 12);

    // 4) BASKET performance — recent move of the Trump-linked names we have data for
    const perf = [];
    for (const m of MAP) {
      const mk = bus.market[resolve(m.sym)];
      if (mk && mk.pct24h != null) perf.push({ sym: m.sym, name: m.name, sign: m.sign, ret: +mk.pct24h.toFixed(2), tv: (bus.tvRatings && bus.tvRatings[resolve(m.sym)] || {}).label || null });
    }
    perf.sort((a, b) => b.ret - a.ret);
    bus.trump.basket = perf.length ? {
      tracked: perf.length,
      avg: +(perf.reduce((a, p) => a + p.ret, 0) / perf.length).toFixed(2),
      leaders: perf.slice(0, 5), laggards: perf.slice(-5).reverse(),
    } : null;

    // 5) his most recent posts (with any tickers detected)
    bus.trump.posts = lane.slice(0, 20).map(h => ({
      source: h.source, title: h.title, url: h.url || '', at: h.at, score: h.score,
      tickers: MAP.filter(m => new RegExp('\\b' + m.sym + '\\b').test(h.title) || new RegExp('\\b' + m.name.split(/[ (]/)[0] + '\\b', 'i').test(h.title)).map(m => m.sym),
    }));

    bus.trump.policyThemes = themes;
    bus.trump.quiver = bus.quiver || { enabled: false };
    bus.trump.narrative = narrate(themes, signals, bus.trump.basket);
    bus.trump.updated = new Date().toLocaleTimeString();
  }

  function narrate(themes, signals, basket) {
    const hot = Object.entries(themes).filter(([, v]) => v > 0.3).sort((a, b) => b[1] - a[1]);
    const parts = [];
    const sp = (bus.trump.speeches || [])[0];
    if (sp && sp.at && Date.now() - new Date(sp.at).getTime() < 24 * 3600e3)
      parts.push(`Latest from his own mouth: "${sp.title.slice(0, 90)}" (${sp.source}).`);
    const ev = (bus.trump.events || [])[0];
    if (ev) parts.push(`On the calendar: "${ev.title.slice(0, 80)}"${ev.themes.length ? ' → pre-warming ' + ev.themes.join('/') : ''}.`);
    if (hot.length) {
      parts.push(`Trump's live focus: ${hot.slice(0, 3).map(([t, v]) => `${t} (${v})`).join(', ')}.`);
      const benef = MAP.filter(m => hot.some(([t]) => THEMES[t] && THEMES[t].cats.includes(m.cat)) && m.sign > 0).slice(0, 6).map(m => m.sym);
      const hurt = MAP.filter(m => hot.some(([t]) => THEMES[t] && THEMES[t].cats.includes(m.cat)) && m.sign < 0).map(m => m.sym);
      if (benef.length) parts.push(`Likely beneficiaries: ${benef.join(', ')}.`);
      if (hurt.length) parts.push(`Likely under pressure: ${hurt.join(', ')}.`);
    } else {
      parts.push('No hot policy theme in his posts right now — standing policy linkages only (energy, defence, crypto, tariffs, immigration).');
    }
    if (basket) parts.push(`Trump-linked basket (${basket.tracked} names we price) is ${basket.avg >= 0 ? 'up' : 'down'} ${basket.avg}% on the day; best ${basket.leaders[0] ? basket.leaders[0].sym + ' ' + basket.leaders[0].ret + '%' : '—'}.`);
    parts.push('The fleet treats this as ONE advisory input among ~40 agents — never a blind follow.');
    return parts.join(' ');
  }

  setInterval(tick, TICK_MS);
  setTimeout(tick, 14000);
  console.log(`[trumptrades] Trump trading desk armed — ${MAP.length} linked equities, policy-theme detection, congress cross-ref, basket perf, advisory signals`);
}
module.exports = { start };
