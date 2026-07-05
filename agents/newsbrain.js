'use strict';
// AGENT: NEWS BRAIN — the interpreter. It doesn't collect news; it MAKES SENSE of it.
// Takes the raw stream from the News Radar and produces, every ~20s:
//   • a plain-English NARRATIVE of what is driving markets right now
//   • a SECTOR heatmap (which sectors the news is pushing, and how hard)
//   • ranked per-SYMBOL leans, each grounded in the historian's century record
//   • actionable CALLS ("news says lean X on Y because Z")
//   • a live NEWS-vs-YOUR-HOLDINGS read (agrees / fights each open position)
const { sectorOf } = require('../lib/fleet');

const BRAIN_MS = 20000;

const THEME_MAP = {
  fed:       { good: ['finance'], bad: ['reit', 'tech', 'utilities'], label: 'Fed / rates', note: 'rates drive growth & rate-sensitive names' },
  ecb:       { good: ['finance'], bad: ['reit', 'tech'], label: 'ECB', note: 'euro-area rate path' },
  boe:       { good: ['finance'], bad: ['reit'], label: 'Bank of England', note: 'UK rate path' },
  tariff:    { good: ['industrials', 'materials'], bad: ['tech', 'auto', 'consumer', 'semis'], label: 'Tariffs / trade', note: 'tariffs hit importers & supply chains' },
  war:       { good: ['energy', 'gold', 'defense', 'industrials'], bad: ['airlines', 'travel', 'consumer'], label: 'War / geopolitics', note: 'conflict = flight to safety + energy/defence bid' },
  opec:      { good: ['energy'], bad: ['airlines', 'travel'], label: 'Oil / OPEC', note: 'oil supply moves energy vs fuel-burners' },
  gold:      { good: ['gold', 'materials'], bad: [], label: 'Gold', note: 'safe-haven demand' },
  defense:   { good: ['defense', 'industrials'], bad: [], label: 'Defence', note: 'rising military spend' },
  shipping:  { good: ['energy', 'materials'], bad: ['airlines', 'consumer'], label: 'Shipping / freight', note: 'freight disruption raises input costs' },
  china:     { good: ['materials', 'energy'], bad: ['tech', 'semis', 'auto'], label: 'China', note: 'China demand & supply-chain exposure' },
  ai:        { good: ['semis', 'tech'], bad: [], label: 'AI / semis', note: 'AI capex flows to chips & software' },
  crypto:    { good: ['crypto', 'finance'], bad: [], label: 'Crypto', note: 'crypto risk-appetite proxy' },
  recession: { good: ['utilities', 'consumer', 'health'], bad: ['auto', 'airlines', 'travel', 'industrials'], label: 'Recession risk', note: 'defensives beat cyclicals in a slowdown' },
  earnings:  { good: [], bad: [], label: 'Earnings season', note: 'single-name catalyst risk' },
  mna:       { good: ['finance'], bad: [], label: 'M&A', note: 'deal activity = risk appetite' },
};

function start(bus) {
  bus.newsBrain = { bias: {}, themes: {}, sectors: [], top: [], calls: [], holdings: [], narrative: 'warming up…', rationale: {}, updated: null };

  function historyWeight(sym) {
    const lt = bus.longTerm && bus.longTerm[sym];
    if (!lt) return { mul: 1, regime: 0, note: '' };
    const regime = lt.regime || 0;
    return { mul: 1 + 0.35 * regime, regime, note: lt.note || '' };
  }
  const clamp = v => Math.max(-1, Math.min(1, v));

  function think() {
    if (bus.beat) bus.beat('newsbrain');
    const radar = bus.newsRadar;
    if (!radar || !radar.headlines || !radar.headlines.length) return;

    const bias = {}, rationale = {}, secBias = {};
    const add = (key, v, why) => { bias[key] = (bias[key] || 0) + v; (rationale[key] = rationale[key] || []).push(why); };
    const addSec = (sec, v, why) => { secBias[sec] = (secBias[sec] || 0) + v; };

    // 1) THEME → SECTOR from the radar's entity aggregates
    const themes = {};
    for (const [ent, stat] of Object.entries(radar.byEntity || {})) {
      const map = THEME_MAP[ent];
      themes[ent] = +clamp(stat.score).toFixed(2);   // bound to −1..+1 so a few extreme headlines don't print "-1.75"
      if (!map || stat.n < 2) continue;
      const s = clamp(stat.score);
      for (const sec of map.bad)  { add('sector:' + sec, s * 0.6, `${map.label} (${s}) → ${map.note}`);  addSec(sec, s * 0.6, ent); }
      for (const sec of map.good) { add('sector:' + sec, -s * 0.5, `${map.label} (${s}) → ${map.note}`); addSec(sec, -s * 0.5, ent); }
    }

    // 2) NAMED-INSTRUMENT news, weighted by the historian's verdict
    const perKey = (bus.news && bus.news.perKey) || {};
    for (const [sym, sc] of Object.entries(perKey)) {
      if (!sc) continue;
      const hw = historyWeight(sym);
      add(sym, sc * 0.4 * hw.mul, `direct news ${sc} × ${hw.regime > 0 ? 'century bull' : hw.regime < 0 ? 'century bear' : 'flat'} trend`);
      const sb = bias['sector:' + sectorOf(sym)];
      if (sb) add(sym, sb * 0.3, `${sectorOf(sym)} sector tilt ${sb.toFixed(2)}`);
    }
    // fold in the correlator's live per-stock impact (news + chart cross-check)
    for (const [sym, v] of Object.entries(bus.newsImpact || {})) if (v) add(sym, v * 0.3, `headline→stock impact ${v} (chart-checked)`);

    // 3) TRUMP lane — fast + directional
    if (radar.trumpFeed && radar.trumpFeed.length) {
      const tScore = +(radar.trumpFeed.reduce((a, h) => a + h.score, 0) / radar.trumpFeed.length).toFixed(2);
      themes.trump = tScore;
      for (const h of radar.trumpFeed) for (const ent of h.entities) {
        const map = THEME_MAP[ent]; if (!map) continue;
        for (const sec of map.bad)  { add('sector:' + sec, h.score * 0.4, `Trump on ${map.label}: "${h.title.slice(0, 50)}"`); addSec(sec, h.score * 0.4, 'trump'); }
        for (const sec of map.good) { addSec(sec, -h.score * 0.35, 'trump'); }
      }
    }

    // ── publish: bias, sectors, top, calls, holdings, narrative ──
    const finalBias = {}, finalRat = {};
    for (const [k, v] of Object.entries(bias)) { finalBias[k] = +clamp(v).toFixed(2); finalRat[k] = (rationale[k] || []).slice(0, 4); }

    const sectors = Object.entries(secBias).map(([sec, v]) => ({ sector: sec, bias: +clamp(v).toFixed(2) }))
      .sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));

    const top = Object.entries(finalBias).filter(([k]) => !k.startsWith('sector:'))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 25)
      .map(([sym, b]) => ({ sym, bias: b, dir: b > 0.15 ? 'BULLISH' : b < -0.15 ? 'BEARISH' : 'neutral', why: (finalRat[sym] || [])[0] || '' }));

    // actionable calls — strongest leans that also have a chart or history behind them
    const calls = top.filter(t => Math.abs(t.bias) > 0.25).slice(0, 12).map(t => {
      const tv = bus.tvRatings && bus.tvRatings[t.sym];
      const agree = tv ? (Math.sign(tv.rec) === Math.sign(t.bias)) : null;
      return { sym: t.sym, action: t.bias > 0 ? 'LEAN LONG' : 'AVOID / LEAN SHORT', bias: t.bias, why: t.why,
        chart: tv ? `${tv.label} (${agree ? 'agrees' : 'disagrees'})` : 'no chart yet' };
    });

    // NEWS vs YOUR HOLDINGS — always computed from live positions
    const holds = Object.keys(bus.state.t212.positions || {});
    const holdings = holds.map(sym => {
      const b = finalBias[sym] != null ? finalBias[sym] : (finalBias['sector:' + sectorOf(sym)] || 0);
      return { sym, bias: +b.toFixed(2), verdict: b > 0.12 ? 'NEWS SUPPORTS ✓' : b < -0.12 ? 'NEWS FIGHTS ⚠' : 'news neutral',
        why: (finalRat[sym] || finalRat['sector:' + sectorOf(sym)] || [])[0] || `${sectorOf(sym)} sector` };
    }).sort((a, b) => a.bias - b.bias);

    bus.newsBrain = {
      bias: finalBias, rationale: finalRat, themes, sectors, top, calls, holdings,
      narrative: narrate(radar, themes, sectors, top),
      updated: new Date().toLocaleTimeString(),
    };
  }

  // Plain-English "what's driving markets" paragraph.
  function narrate(radar, themes, sectors, top) {
    const mood = radar.global || 0;
    const moodWord = mood > 0.15 ? 'risk-ON, broadly positive' : mood < -0.15 ? 'risk-OFF, defensive' : 'mixed / rangebound';
    const parts = [`Global news mood is ${moodWord} (${mood >= 0 ? '+' : ''}${mood}).`];

    const drivers = Object.entries(themes).filter(([, v]) => Math.abs(v) > 0.12)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    if (drivers.length) parts.push('Top drivers: ' + drivers.map(([t, v]) => {
      const m = THEME_MAP[t]; return `${m ? m.label : t} ${v >= 0 ? '+' : ''}${v}`;
    }).join(', ') + '.');

    if (radar.warBoard && radar.warBoard.active) parts.push(radar.warNarrative);

    const strongSec = sectors.filter(s => Math.abs(s.bias) > 0.15).slice(0, 4);
    if (strongSec.length) parts.push('Sector tilt: ' +
      strongSec.map(s => `${s.sector} ${s.bias > 0 ? 'favoured' : 'pressured'}`).join(', ') + '.');

    const worst = Object.entries(radar.byRegion || {}).filter(([, v]) => v.n > 3).sort((a, b) => a[1].score - b[1].score)[0];
    if (worst) parts.push(`Weakest region: ${worst[0]} (${worst[1].score}).`);

    const pick = top.find(t => t.bias > 0.25), avoid = top.find(t => t.bias < -0.25);
    if (pick) parts.push(`Bot's lean: favouring ${pick.sym}${avoid ? `, cautious on ${avoid.sym}` : ''}.`);
    return parts.join(' ');
  }

  setInterval(think, BRAIN_MS);
  setTimeout(think, 12000);
  console.log('[newsbrain] interpreter armed — narrative + sector heatmap + actionable calls + live holdings read, grounded in century history');
}
module.exports = { start };
