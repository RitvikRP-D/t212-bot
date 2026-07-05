'use strict';
// THE TEN DESKS — institutional-style analysis agents, each on its own clock, all fed
// automatically from the live bus: YOUR actual holdings, the TradingView metric sweep
// (technicals for ~2.8k rated names + fundamentals for ~6k), the historian, the news
// radar/correlator, regime, earnings calendar. No placeholders — "my portfolio" IS
// bus.state.t212.positions, "the market" IS the 16k universe.
//   ① screener  (Goldman)      ② valuation (Morgan Stanley DCF)  ③ riskdesk (Bridgewater)
//   ④ earnings  (JPMorgan)     ⑤ portfolio (BlackRock)           ⑥ techdesk (Citadel)
//   ⑦ dividend  (Harvard)      ⑧ moat      (Bain)                ⑨ patterns (RenTech)
//   ⑩ macro     (McKinsey)
const { sectorOf, countryOf } = require('../lib/fleet');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = v => v == null ? null : +(+v).toFixed(2);

function start(bus) {
  bus.desks = {};
  const F = () => bus.fundamentals || {};
  const TV = () => bus.tvRatings || {};
  const holdings = () => Object.entries(bus.state.t212.positions || {}).map(([sym, p]) => ({ sym, ...p }));
  const eq = () => (bus.riskStatus && bus.riskStatus.equity) || bus.t212Status?.total || 0;
  const news = sym => (bus.newsImpact && bus.newsImpact[sym]) || 0;

  // ratedUniverse: names with BOTH a TV technical rating and fundamentals — the desks' working set
  function rated() {
    const out = [];
    const f = F(), tv = TV();
    for (const [sym, d] of Object.entries(f)) {
      if (!tv[sym]) continue;
      out.push({ sym, f: d, tv: tv[sym] });
    }
    return out;
  }

  // ═ ① GOLDMAN SCREENER — quality+value+chart composite over the whole rated set ═
  function screener() {
    const rows = rated();
    if (!rows.length) return;
    const bySector = {};
    for (const r of rows) if (r.f.pe > 0) (bySector[r.f.sector] = bySector[r.f.sector] || []).push(r.f.pe);
    const secPE = {}; for (const [s, a] of Object.entries(bySector)) { a.sort((x, y) => x - y); secPE[s] = a[Math.floor(a.length / 2)]; }
    const scored = rows.map(r => {
      const { f, tv, sym } = r;
      let q = 0; const why = [];
      if (f.pe > 0 && secPE[f.sector] && f.pe < secPE[f.sector]) { q += 0.2; why.push(`P/E ${r2(f.pe)} < sector ${r2(secPE[f.sector])}`); }
      if (f.epsG > 5) { q += clamp(f.epsG / 100, 0, 0.25); why.push(`EPS +${r2(f.epsG)}%`); }
      if (f.revG > 5) { q += clamp(f.revG / 120, 0, 0.2); why.push(`rev +${r2(f.revG)}%`); }
      if (f.de != null && f.de < 1) { q += 0.1; why.push(`D/E ${r2(f.de)}`); }
      if (f.om > 15) q += 0.1;
      q += clamp(tv.rec * 0.35, -0.35, 0.35); if (tv.rec > 0.3) why.push(`chart ${tv.label}`);
      q += clamp(news(sym) * 0.15, -0.15, 0.15);
      const moat = (f.gm > 45 && f.om > 20 && f.mcap > 20e9) ? 'STRONG' : (f.gm > 30 && f.om > 10) ? 'MODERATE' : 'WEAK';
      const atr = tv.atrPct || 0.02;
      const risk = clamp(Math.round(3 + (f.beta || 1) * 2 + atr * 100 - (f.mcap > 50e9 ? 2 : 0)), 1, 10);
      const g = clamp((f.epsG || 8) / 100, 0.03, 0.25);
      return { sym, name: f.industry || f.sector, px: r2(f.px), pe: r2(f.pe), secPE: r2(secPE[f.sector]), revG: r2(f.revG), epsG: r2(f.epsG), de: r2(f.de), divY: r2(f.divY), moat, risk,
        bull: r2(f.px * (1 + g + 2.5 * atr * 4)), bear: r2(f.px * (1 - 2.5 * atr * 4)),
        entry: r2(f.px * (1 - atr)), stop: r2(f.px * (1 - 2.5 * atr)), q: +q.toFixed(3), why: why.slice(0, 3).join(' · ') };
    }).sort((a, b) => b.q - a.q);
    const scores = {}; for (const s of scored) scores[s.sym] = clamp(0.5 + s.q * 0.5, 0, 1);
    bus.desks.screener = { top: scored.slice(0, 10), scores, pool: scored.length, updated: new Date().toLocaleTimeString() };
  }

  // ═ ② MORGAN STANLEY DCF — 5-yr EPS-as-FCF model on holdings + screener top picks ═
  function valuation() {
    const f = F(); const list = [...new Set([...holdings().map(h => h.sym), ...((bus.desks.screener?.top || []).map(t => t.sym))])].slice(0, 25);
    const out = [];
    for (const sym of list) {
      const d = f[sym]; if (!d || !d.eps || d.eps <= 0 || !d.px) continue;
      const g = clamp((d.epsG != null ? d.epsG : 8) / 100, 0.02, 0.20);
      const wacc = clamp(0.045 + (d.beta || 1) * 0.055, 0.06, 0.16);
      const tg = 0.025;
      let pv = 0, e = d.eps;
      for (let y = 1; y <= 5; y++) { e *= (1 + g * (1 - y * 0.08)); pv += e / Math.pow(1 + wacc, y); }
      const term = (e * (1 + tg)) / (wacc - tg) / Math.pow(1 + wacc, 5);
      let fair = pv + term;
      // EPS-as-FCF systematically overstates banks/insurers/REITs — haircut + cap so
      // the desk never screams "+300% undervalued" off a structurally wrong model.
      const financial = /finance|insur|reit|bank/i.test(d.sector || '');
      if (financial) fair = Math.min(fair * 0.5, d.px * 1.6);
      fair = Math.min(fair, d.px * 2.5);
      const gap = clamp((fair / d.px - 1) * 100, -80, 150);
      out.push({ sym, px: r2(d.px), fair: r2(fair), gap: r2(gap), wacc: r2(wacc * 100), g: r2(g * 100),
        verdict: (gap > 20 ? 'UNDERVALUED' : gap < -20 ? 'OVERVALUED' : 'FAIR') + (financial ? ' (low confidence: financial)' : ''),
        sens: { low: r2(pvAt(d, g, wacc - 0.01, tg)), high: r2(pvAt(d, g, wacc + 0.01, tg)) },
        breakIf: `growth <${r2(g * 50)}% or WACC >${r2((wacc + 0.02) * 100)}%` });
    }
    bus.desks.valuation = { verdicts: out.sort((a, b) => b.gap - a.gap), updated: new Date().toLocaleTimeString() };
  }
  function pvAt(d, g, wacc, tg) { let pv = 0, e = d.eps; for (let y = 1; y <= 5; y++) { e *= (1 + g * (1 - y * 0.08)); pv += e / Math.pow(1 + wacc, y); } return pv + (e * (1 + tg)) / (Math.max(wacc - tg, 0.02)) / Math.pow(1 + wacc, 5); }

  // ═ ③ BRIDGEWATER RISK — correlation, concentration, stress test on ACTUAL book ═
  function riskdesk() {
    const hs = holdings(); const f = F(), tv = TV();
    if (!hs.length) { bus.desks.risk = { empty: true, note: 'no open positions — risk desk standing by', updated: new Date().toLocaleTimeString() }; return; }
    const w = {}; let tot = 0; for (const h of hs) { w[h.sym] = h.invested || 1; tot += w[h.sym]; }
    const secPct = {}, geoPct = {};
    let pBeta = 0;
    for (const h of hs) {
      const wt = w[h.sym] / tot;
      secPct[sectorOf(h.sym)] = r2(((secPct[sectorOf(h.sym)] || 0) + wt * 100));
      geoPct[countryOf(h.sym)] = r2(((geoPct[countryOf(h.sym)] || 0) + wt * 100));
      pBeta += wt * ((f[h.sym]?.beta ?? tv[h.sym]?.beta) || 1);
    }
    const pairs = [];
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const a = bus.market[hs[i].sym]?.closes, b = bus.market[hs[j].sym]?.closes;
      const c = corr(a, b); if (c != null) pairs.push({ pair: hs[i].sym + '×' + hs[j].sym, corr: r2(c) });
    }
    pairs.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
    const maxSec = Math.max(...Object.values(secPct), 0);
    const stress = r2(-(pBeta * 8 + maxSec / 10));
    bus.desks.risk = {
      beta: r2(pBeta), sectors: secPct, geo: geoPct, topCorr: pairs.slice(0, 5),
      stress: `recession shock (-8% mkt): est ${stress}% book drawdown`,
      tail: [{ scenario: 'rate shock', p: '15%', hit: r2(-pBeta * 5) + '%' }, { scenario: 'sector-specific bust', p: '10%', hit: r2(-maxSec / 4) + '%' }],
      advice: [maxSec > 50 ? `⚠ ${r2(maxSec)}% in one sector — diversify` : '✓ sector spread ok',
        pBeta > 1.3 ? `⚠ portfolio beta ${r2(pBeta)} — high market sensitivity` : `✓ beta ${r2(pBeta)}`,
        (pairs[0] && Math.abs(pairs[0].corr) > 0.8) ? `⚠ ${pairs[0].pair} move together (${pairs[0].corr})` : '✓ correlations tolerable'],
      updated: new Date().toLocaleTimeString(),
    };
  }
  function corr(a, b) {
    if (!a || !b || a.length < 20 || b.length < 20) return null;
    const n = Math.min(a.length, b.length, 60);
    const ra = [], rb = [];
    for (let i = 1; i < n; i++) { ra.push(a[a.length - i] / a[a.length - i - 1] - 1); rb.push(b[b.length - i] / b[b.length - i - 1] - 1); }
    const ma = ra.reduce((x, y) => x + y, 0) / ra.length, mb = rb.reduce((x, y) => x + y, 0) / rb.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
    return (da && db) ? num / Math.sqrt(da * db) : null;
  }

  // ═ ④ JPMORGAN EARNINGS — pre-earnings briefs for names reporting soon ═
  function earningsdesk() {
    const soon = (bus.earnings && bus.earnings.soon) || {}; const f = F(), tv = TV();
    const briefs = [];
    const watch = new Set([...holdings().map(h => h.sym), ...Object.keys(bus.market || {})]);
    for (const [base, date] of Object.entries(soon)) {
      const sym = [...watch].find(s => s.split('.')[0] === base) || base;
      const d = f[sym], t = tv[sym];
      const implied = t?.atrPct ? r2(t.atrPct * 100 * 1.8) : null;
      briefs.push({ sym, date, px: r2(d?.px), implied: implied ? `±${implied}%` : '—',
        chart: t?.label || '—', newsLean: r2(news(sym)),
        bull: implied ? `beat → +${implied}%` : 'beat → pop', bear: implied ? `miss → -${r2(implied * 1.2)}%` : 'miss → drop',
        play: (bus.profile?.name === 'real') ? 'WAIT (blackout — bot skips entries into earnings)' : (t?.rec > 0.3 && news(sym) > 0.2 ? 'momentum into print, exit before close' : 'WAIT') });
    }
    bus.desks.earnings = { briefs: briefs.slice(0, 15), updated: new Date().toLocaleTimeString() };
  }

  // ═ ⑤ BLACKROCK PORTFOLIO — target allocation for the ACTUAL account size/profile ═
  function portfolio() {
    const e = eq(); if (!e) return;
    const prof = bus.profile || { name: 'practice' };
    const real = prof.name === 'real';
    const alloc = real
      ? [{ bucket: 'Core equity (top screener quality)', pct: 45 }, { bucket: 'Dividend income sleeve', pct: 20 }, { bucket: 'Momentum satellites (tvHot)', pct: 15 }, { bucket: 'Commodities ETCs', pct: 5 }, { bucket: 'Crypto ETPs', pct: 5 }, { bucket: 'Cash buffer', pct: 10 }]
      : [{ bucket: 'Momentum satellites (tvHot)', pct: 35 }, { bucket: 'Core equity (top screener quality)', pct: 30 }, { bucket: 'Crypto ETPs', pct: 15 }, { bucket: 'Commodities ETCs', pct: 10 }, { bucket: 'Dividend sleeve', pct: 5 }, { bucket: 'Cash buffer', pct: 5 }];
    const core = (bus.desks.screener?.top || []).slice(0, 5).map(t => t.sym);
    const sat = (bus.tvHot || []).slice(0, 5);
    const lts = Object.values(bus.longTerm || {});
    const histRet = lts.length ? r2(lts.reduce((a, l) => a + (l.cagr || 7), 0) / lts.length) : 7;
    bus.desks.portfolio = {
      equity: r2(e), profile: prof.name, alloc, core, satellites: sat,
      expReturn: `${r2(histRet * 0.6)}–${r2(histRet * 1.2)}%/yr (century-data grounded)`,
      expDrawdown: `${real ? '8–12' : '15–25'}% in a bad year`,
      rebalance: 'drift >20% from target OR monthly, whichever first',
      dca: `£${r2(e / 20)} weekly if adding funds`, benchmark: 'SPY total return',
      policy: `Stay inside risk floor (-10%), daily breaker (-${((bus.profile?.dailyMaxLoss || 0.06) * 100)}%), profit lock; never all-in one venue/sector.`,
      updated: new Date().toLocaleTimeString(),
    };
  }

  // ═ ⑥ CITADEL TECH DESK — full TA report card per holding + hot name ═
  function techdesk() {
    const tv = TV(); const cards = {};
    const list = [...new Set([...holdings().map(h => h.sym), ...(bus.tvHot || []).slice(0, 12)])].slice(0, 20);
    for (const sym of list) {
      const t = tv[sym]; const mk = bus.market[sym]; if (!t && !mk) continue;
      const cl = mk?.closes || [];
      const px = mk?.price || t?.close;
      const hi = cl.length ? Math.max(...cl.slice(-90)) : null, lo = cl.length ? Math.min(...cl.slice(-90)) : null;
      const fib = (hi && lo && hi > lo) ? { f382: r2(hi - (hi - lo) * 0.382), f5: r2(hi - (hi - lo) * 0.5), f618: r2(hi - (hi - lo) * 0.618) } : null;
      const atr = t?.atrPct || 0.02;
      const trendD = cl.length > 10 ? (cl[cl.length - 1] > cl[cl.length - 10] ? 'UP' : 'DOWN') : '—';
      const lt = bus.longTerm?.[sym];
      cards[sym] = { sym, px: r2(px), verdict: t?.label || '—', score: t?.rec ?? 0, rsi: r2(t?.rsi),
        trend: { daily: trendD, monthly: lt ? (lt.regime > 0 ? 'UP' : 'DOWN') : '—' },
        support: r2(lo), resistance: r2(hi), fib,
        entry: r2(px), stop: r2(px * (1 - 2 * atr)), target: r2(px * (1 + 3 * atr)), rr: '1:1.5',
        notes: t?.detail || '' };
    }
    bus.desks.tech = { cards, updated: new Date().toLocaleTimeString() };
  }

  // ═ ⑦ HARVARD DIVIDEND — income sleeve from real yields/payouts, sized to the account ═
  function dividend() {
    const rows = rated().filter(r => r.f.divY > 2.5 && r.f.mcap > 2e9 && (r.f.de == null || r.f.de < 2.5));
    const picks = rows.map(r => {
      const { f, sym, tv } = r;
      let safety = 5;
      if (f.payout != null) safety += f.payout < 60 ? 2 : f.payout > 90 ? -2 : 0;
      if (f.om > 15) safety += 1; if ((f.beta || 1) < 0.9) safety += 1; if (f.de != null && f.de < 0.8) safety += 1;
      safety = clamp(safety, 1, 10);
      return { sym, yield: r2(f.divY), safety, payout: r2(f.payout), sector: f.sector, chart: tv.label, flag: f.payout > 90 ? '⚠ payout unsustainable' : '' };
    }).sort((a, b) => b.safety - a.safety || b.yield - a.yield).slice(0, 20);
    const e = eq();
    const avgY = picks.length ? picks.reduce((a, p) => a + p.yield, 0) / picks.length : 0;
    bus.desks.dividend = { picks, monthlyIncome: r2(e * avgY / 100 / 12), avgYield: r2(avgY),
      drip10y: r2(e * Math.pow(1 + (avgY + 5) / 100, 10)), updated: new Date().toLocaleTimeString() };
  }

  // ═ ⑧ BAIN MOAT DESK — competitive landscape of the 3 busiest sectors ═
  function moat() {
    const rows = rated();
    const bySec = {};
    for (const r of rows) if (r.f.sector) (bySec[r.f.sector] = bySec[r.f.sector] || []).push(r);
    const secs = Object.entries(bySec).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
    const reports = secs.map(([sec, list]) => {
      const top = list.sort((a, b) => (b.f.mcap || 0) - (a.f.mcap || 0)).slice(0, 7)
        .map(r => ({ sym: r.sym, mcap: r2((r.f.mcap || 0) / 1e9) + 'B', om: r2(r.f.om), revG: r2(r.f.revG), pe: r2(r.f.pe),
          moat: (r.f.gm > 45 && r.f.om > 20) ? 'STRONG' : (r.f.gm > 30) ? 'MODERATE' : 'WEAK', chart: r.tv.label }));
      const win = [...top].sort((a, b) => (parseFloat(b.om) || 0) + (parseFloat(b.revG) || 0) - (parseFloat(a.om) || 0) - (parseFloat(a.revG) || 0))[0];
      const cat = (bus.newsCorrelations || []).find(c => c.sym === win?.sym);
      return { sector: sec, table: top, pick: win?.sym, why: win ? `best margin+growth combo in ${sec}` : '—', catalyst: cat ? cat.headline : 'watching news flow' };
    });
    bus.desks.moat = { reports, updated: new Date().toLocaleTimeString() };
  }

  // ═ ⑨ RENTECH PATTERNS — statistical edges from the century archive + live tape ═
  function patterns() {
    const list = [...new Set([...holdings().map(h => h.sym), ...((bus.desks.screener?.top || []).slice(0, 8).map(t => t.sym))])].slice(0, 15);
    const memos = [];
    for (const sym of list) {
      const lt = bus.longTerm?.[sym]; const mk = bus.market[sym]; const t = TV()[sym];
      const edges = [];
      if (lt) { edges.push(`${lt.years}y regime: ${lt.regime > 0 ? 'secular bull' : 'secular bear'} (${lt.cagr ?? '—'}%/yr, max DD ${lt.maxDD}%)`);
        if (lt.yr12 != null) edges.push(`12-mo momentum ${lt.yr12 > 0 ? '+' : ''}${lt.yr12}% ${lt.yr12 > 15 ? '→ momentum edge' : ''}`); }
      const cb = bus.news?.congressBoost?.[sym.split('.')[0]];
      if (cb) edges.push(`congress insiders net-BUYING (signal ${r2(cb)})`);
      if (mk?.volSurge > 1.5) edges.push(`volume ${r2(mk.volSurge)}× average — institutional footprint`);
      const ni = news(sym); if (Math.abs(ni) > 0.2) edges.push(`news flow ${ni > 0 ? 'tailwind' : 'headwind'} ${r2(ni)}`);
      if (t?.rec != null) edges.push(`122-metric chart composite ${r2(t.rec)} (${t.label})`);
      memos.push({ sym, edges, edge: edges.length >= 3 ? 'QUANTIFIABLE EDGE' : 'weak edge — pass' });
    }
    bus.desks.patterns = { memos, updated: new Date().toLocaleTimeString() };
  }

  // ═ ⑩ McKINSEY MACRO — rates/inflation/geo read → sector rotation + concrete moves ═
  function macro() {
    const ent = (bus.newsRadar && bus.newsRadar.byEntity) || {};
    const g = k => ent[k]?.score ?? 0;
    const rates = g('fed'), war = g('war'), china = g('china'), tariff = g('tariff'), rec = g('recession'), ai = g('ai'), opec = g('opec');
    const reg = bus.regime?.state || 'unknown';
    const tilt = {};
    tilt.tech = clamp(rates * 0.5 + ai * 0.5 - tariff * 0.3, -1, 1);
    tilt.semis = clamp(ai * 0.6 - china * 0.3 - tariff * 0.3, -1, 1);
    tilt.finance = clamp(-rates * 0.4 + 0.1, -1, 1);
    tilt.energy = clamp(-opec * 0.3 - war * 0.5, -1, 1);
    tilt.defense = clamp(-war * 0.6, -1, 1);
    tilt.utilities = clamp(-rec * 0.5, -1, 1);
    tilt.consumer = clamp(rec * 0.4 + 0.05, -1, 1);
    for (const k of Object.keys(tilt)) tilt[k] = r2(tilt[k]);
    const hs = holdings();
    const adjust = hs.map(h => { const s = sectorOf(h.sym); const tv = tilt[s]; return tv == null ? null : { sym: h.sym, sector: s, call: tv > 0.2 ? 'OVERWEIGHT ✓ macro tailwind' : tv < -0.2 ? 'UNDERWEIGHT — macro headwind' : 'HOLD' }; }).filter(Boolean);
    bus.desks.macro = {
      briefing: [
        `Rates mood ${r2(rates)} → ${rates < -0.15 ? 'hawkish pressure on growth/REITs' : rates > 0.15 ? 'dovish tailwind for growth' : 'neutral'}`,
        `Geopolitics ${r2(war)} → ${war < -0.2 ? 'risk-off: energy/defence/gold bid' : 'calm'}`,
        `China ${r2(china)} · tariffs ${r2(tariff)} → supply-chain ${tariff < -0.2 ? 'stress' : 'stable'}`,
        `Recession chatter ${r2(rec)} → ${rec < -0.2 ? 'defensives over cyclicals' : 'cyclicals ok'}`,
        `Tape regime: ${reg}`,
      ],
      sectorTilt: tilt, adjustments: adjust,
      timeline: 'tariff/war headlines: hours-days · rates: weeks · recession: months',
      updated: new Date().toLocaleTimeString(),
    };
  }

  // ── scheduler: SYNCED CADENCE. All desks read already-computed bus data (fundamentals,
  // TV ratings, history) so they're cheap to run often. Two synced tiers replace the old
  // 60–600s spread: FAST=30s for the live-tape desks, MED=45s for heavier model/landscape.
  const FAST = 30e3, MED = 45e3;
  const DESKS = [
    ['desk-screener', screener, FAST], ['desk-valuation', valuation, MED], ['desk-risk', riskdesk, FAST],
    ['desk-earnings', earningsdesk, MED], ['desk-portfolio', portfolio, MED], ['desk-tech', techdesk, FAST],
    ['desk-dividend', dividend, MED], ['desk-moat', moat, MED], ['desk-patterns', patterns, FAST], ['desk-macro', macro, FAST],
  ];
  let stagger = 0;
  for (const [name, fn, ms] of DESKS) {
    setInterval(() => { try { if (bus.beat) bus.beat(name); fn(); } catch (e) { console.log(`[${name}] ${e.message}`); } }, ms);
    setTimeout(() => { try { fn(); } catch (e) {} }, 15000 + (stagger += 1500));  // stagger first run so they don't all fire at once
  }
  console.log('[desks] 10 institutional desks armed — Goldman screener · MS DCF · Bridgewater risk · JPM earnings · BlackRock portfolio · Citadel TA · Harvard dividend · Bain moat · RenTech patterns · McKinsey macro');
}
module.exports = { start };
