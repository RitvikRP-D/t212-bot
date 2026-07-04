'use strict';
// Shared NEWS SENTIMENT ENGINE — used by the news + deep-press agents.
// Upgrades over naive word-counting:
//   • weighted lexicon (a "plunge" is worth more than a "dip")
//   • negation-aware ("not bullish", "fails to beat" flip sign)
//   • diminishing returns (5 buzzwords ≠ 5× the signal — tanh saturation)
//   • source credibility weighting (FT/Reuters > random Google hit)
// Everything is free + offline — pure string math, no API keys.

// weight: strong moves ±2, ordinary moves ±1
const LEX = [
  [2, /\b(surge[sd]?|soar[sed]*|skyrocket|rocket[sed]*|all-time high|record high|blowout|crush(?:ed|es)?|smash(?:ed|es)?|doubl(?:e|ed|es)|tripl(?:e|ed|es)|breakout|upgraded to buy|takeover|acquire[sd]?|buyout)\b/gi],
  [1, /\b(gain[sed]*|rise[sn]?|rising|jump[sed]*|climb[sed]*|beat[s]?|tops\b|topped|upgrade[sd]?|bullish|outperform[sed]*|raise[sd]? guidance|guidance raise|buyback|dividend (?:raise|hike|increase)|partnership|approv(?:al|ed|es)|adopt(?:ion|ed|s)?|recover[sy]*|rebound[sed]*|strong (?:earnings|results|demand|sales)|optimistic|stimulus|rate cut|expansion|record profit|beat[s]? (?:estimates|expectations)|upbeat|momentum)\b/gi],
  [-1, /\b(fall[sen]*|drop[sped]*|declin[es]*|slip[sped]*|dip[sped]*|miss(?:es|ed)?|downgrade[sd]?|bearish|underperform[sed]*|cut[s]? guidance|guidance cut|probe|investigat(?:ion|ing|ed)|recall[sed]*|layoff[s]?|warn[sed]*|weak(?:er|ness)?|concern[sed]*|lawsuit|sue[sd]?|sink[s]?|slump[sed]*|tumbl[es]*|selloff|sell-off|pressure|headwind|caution|soften[sed]*|disappoint[sed]*)\b/gi],
  [-2, /\b(crash(?:ed|es)?|plunge[sd]?|collapse[sd]?|plummet[sed]*|bankrupt(?:cy)?|fraud|scandal|halt(?:ed)? trading|delist[sed]*|default[sed]*|crisis|tank[sed]*|crater[sed]*|nosedive[sd]?|wiped out|slash(?:ed|es)?|gut[s]?|freefall|meltdown|rout|panic)\b/gi],
];
// a sentiment word is negated if one of these appears just before it
const NEGATORS = /\b(not|no|never|without|fails? to|unlikely|denies|deny|avoid[sed]*|isn'?t|aren'?t|wasn'?t|won'?t|can'?t|doesn'?t|didn'?t|halts?|ends?|erases?|reverses?)\b/i;

// per-source credibility multiplier (unknown → 1.0)
const SOURCE_W = {
  FT: 1.25, Economist: 1.25, Reuters: 1.15, Bloomberg: 1.15, BloombergTV: 1.05,
  MarketWatch: 1.05, CNBC: 1.05, 'CNBC-TV': 1.0, WSJ: 1.2, BBC: 1.0,
  Guardian: 0.95, YahooFinance: 0.95, GoogleNews: 0.85, CoinDesk: 1.0, CoinTelegraph: 0.9,
};

// score one headline in [-3, 3], negation-aware, saturating.
function scoreHeadline(title, source) {
  if (!title) return 0;
  const words = title.split(/\s+/);
  let raw = 0;
  for (const [w, re] of LEX) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(title))) {
      // find token index of the match to inspect the 3 words before it for a negator
      const upto = title.slice(0, m.index).split(/\s+/).length;
      const window = words.slice(Math.max(0, upto - 3), upto).join(' ');
      raw += NEGATORS.test(window) ? -w * 0.9 : w;   // negation flips + slightly damps
    }
  }
  if (!raw) return 0;
  const sw = SOURCE_W[source] || 1.0;
  // tanh saturation: many buzzwords give diminishing returns, then × source weight
  const sat = 3 * Math.tanh(raw / 3);
  return +(Math.max(-3, Math.min(3, sat * sw))).toFixed(2);
}

// aggregate a list of {title, source} into a mean score, recency untouched (headlines are fresh)
function scoreAll(heads) {
  for (const h of heads) h.score = scoreHeadline(h.title, h.source);
  const mean = heads.length ? heads.reduce((a, h) => a + h.score, 0) / heads.length : 0;
  return +mean.toFixed(2);
}

// dollar-range → weight for congressional/insider disclosures ("$1,001 - $15,000" etc.)
function amountWeight(amt) {
  if (!amt) return 1;
  const nums = (String(amt).match(/[\d,]+/g) || []).map(s => +s.replace(/,/g, '')).filter(n => n > 0);
  const hi = nums.length ? Math.max(...nums) : 0;
  if (hi >= 1e6) return 2.0;
  if (hi >= 250e3) return 1.6;
  if (hi >= 50e3) return 1.3;
  if (hi >= 15e3) return 1.1;
  if (hi > 0) return 0.8;
  return 1;
}

module.exports = { scoreHeadline, scoreAll, amountWeight, SOURCE_W };
