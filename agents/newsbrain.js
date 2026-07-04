'use strict';
// AGENT: NEWS BRAIN — the interpreter. It doesn't collect news; it MAKES SENSE of it.
// Takes the raw stream from the News Radar, works out WHICH instruments each story
// hits, and then asks the only question that matters for trading: "the last time the
// tape looked like THIS, what happened next?" — using the historian's long-memory
// record (monthly data back to ~1927 where it exists) to ground every call in how
// the asset has ACTUALLY reacted, not a guess.
//
// Output: bus.newsBrain.bias[sym] = a forward-looking, evidence-weighted lean
// (−1 … +1) per symbol/sector, plus a plain-English rationale the dashboard shows.
const { sectorOf } = require('../lib/fleet');

const BRAIN_MS = 45000;

// How a macro/entity theme maps onto sectors + the classic historical reaction.
// Each rule: theme -> { sectors it moves, sign of a NEGATIVE-scored story's effect }.
// (A bullish story flips the sign.) These encode well-documented market linkages.
const THEME_MAP = {
  fed:       { good: ['finance', 'reit', 'tech'], bad: ['reit', 'tech'], note: 'rates drive growth & rate-sensitive names' },
  tariff:    { good: ['industrials', 'materials'], bad: ['tech', 'auto', 'consumer', 'semis'], note: 'tariffs hit importers & supply chains' },
  war:       { good: ['energy', 'gold', 'industrials'], bad: ['airlines', 'travel', 'consumer'], note: 'conflict = flight to safety + energy' },
  opec:      { good: ['energy'], bad: ['airlines', 'travel'], note: 'oil supply moves energy vs fuel-burners' },
  china:     { good: ['materials', 'energy'], bad: ['tech', 'semis', 'auto'], note: 'China demand & supply-chain exposure' },
  ai:        { good: ['semis', 'tech'], bad: [], note: 'AI capex flows to chips & software' },
  crypto:    { good: ['finance'], bad: [], note: 'crypto risk-appetite proxy' },
  recession: { good: ['utilities', 'consumer', 'health'], bad: ['auto', 'airlines', 'travel', 'industrials'], note: 'defensives beat cyclicals in a slowdown' },
  tariffwar: { good: [], bad: ['tech', 'semis'], note: 'trade war compresses tech multiples' },
};

function start(bus) {
  bus.newsBrain = { bias: {}, themes: {}, top: [], rationale: {}, updated: null };

  // historical reaction multiplier: how strongly this symbol has trended lately +
  // its secular regime, so a news lean on a name that's ALREADY in a century-long
  // uptrend counts more than the same lean on a structurally broken one.
  function historyWeight(sym) {
    const lt = bus.longTerm && bus.longTerm[sym];
    if (!lt) return { mul: 1, regime: 0, note: '' };
    const regime = lt.regime || 0;                        // +1 secular bull / −1 bear
    const mom = lt.yr12 != null ? Math.max(-1, Math.min(1, lt.yr12 / 40)) : 0;  // 12-mo momentum, normalised
    // align: news that agrees with the long trend is amplified; fighting it is damped
    return { mul: 1 + 0.35 * regime, regime, mom, note: lt.note || '' };
  }

  function think() {
    if (bus.beat) bus.beat('newsbrain');
    const radar = bus.newsRadar;
    if (!radar || !radar.headlines || !radar.headlines.length) return;

    const bias = {};       // sym/sector -> accumulated evidence-weighted lean
    const rationale = {};   // sym/sector -> reasons
    const add = (key, v, why) => {
      bias[key] = (bias[key] || 0) + v;
      (rationale[key] = rationale[key] || []).push(why);
    };

    // 1) THEME → SECTOR propagation (from the radar's entity aggregates)
    const themes = {};
    for (const [ent, stat] of Object.entries(radar.byEntity || {})) {
      const map = THEME_MAP[ent];
      themes[ent] = stat.score;
      if (!map || stat.n < 2) continue;                     // need corroboration
      const s = stat.score;                                  // −1..+1 mood on the theme
      // a negative theme story pressures 'bad' sectors, lifts 'good' (flight/rotation)
      for (const sec of map.bad) add('sector:' + sec, s * 0.6, `${ent} news (${s}) → ${map.note}`);
      for (const sec of map.good) add('sector:' + sec, -s * 0.5, `${ent} news (${s}) → ${map.note}`);
    }

    // 2) HEADLINE → NAMED INSTRUMENT (per-symbol news already computed by the news agent)
    //    Blend the classic per-key sentiment with the radar's fresher global read,
    //    then weight by the historian's verdict on that name.
    const perKey = (bus.news && bus.news.perKey) || {};
    for (const [sym, sc] of Object.entries(perKey)) {
      if (!sc) continue;
      const hw = historyWeight(sym);
      const lean = sc * 0.4 * hw.mul;
      add(sym, lean, `direct news ${sc} × history(${hw.regime > 0 ? 'bull' : hw.regime < 0 ? 'bear' : 'flat'})`);
      // inherit the sector lean too
      const secBias = bias['sector:' + sectorOf(sym)];
      if (secBias) add(sym, secBias * 0.3, `sector ${sectorOf(sym)} tilt ${secBias.toFixed(2)}`);
    }

    // 3) TRUMP LANE — his posts are fast, market-moving and directional. Weight the
    //    tariff/china/energy/crypto entities inside his feed a touch harder.
    if (radar.trumpFeed && radar.trumpFeed.length) {
      const tScore = radar.trumpFeed.reduce((a, h) => a + h.score, 0) / radar.trumpFeed.length;
      themes.trump = +tScore.toFixed(2);
      for (const h of radar.trumpFeed) {
        for (const ent of h.entities) {
          const map = THEME_MAP[ent];
          if (!map) continue;
          for (const sec of map.bad) add('sector:' + sec, h.score * 0.4, `Trump on ${ent}: "${h.title.slice(0, 60)}"`);
          for (const sec of map.good) add('sector:' + sec, -h.score * 0.35, `Trump on ${ent}: "${h.title.slice(0, 60)}"`);
        }
      }
    }

    // normalise to −1..+1 and publish
    const clamp = v => Math.max(-1, Math.min(1, v));
    const finalBias = {}, finalRat = {};
    for (const [k, v] of Object.entries(bias)) { finalBias[k] = +clamp(v).toFixed(2); finalRat[k] = (rationale[k] || []).slice(0, 4); }

    bus.newsBrain.bias = finalBias;
    bus.newsBrain.rationale = finalRat;
    bus.newsBrain.themes = themes;
    bus.newsBrain.top = Object.entries(finalBias)
      .filter(([k]) => !k.startsWith('sector:'))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 20)
      .map(([sym, b]) => ({ sym, bias: b, why: (finalRat[sym] || [])[0] || '' }));
    bus.newsBrain.updated = new Date().toLocaleTimeString();
  }

  setInterval(think, BRAIN_MS);
  setTimeout(think, 15000);
  console.log('[newsbrain] news interpreter armed — maps stories → instruments, grounds every call in ~century-long historical reaction');
}
module.exports = { start };
