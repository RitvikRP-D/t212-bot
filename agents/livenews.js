'use strict';
// AGENT ⑬: DEEP NEWS — reads the serious press 24/7: Financial Times, The Guardian,
// The Economist, BBC Business, Reuters wire (via Google), plus the video desks —
// Bloomberg TV, CNBC and Yahoo Finance YouTube uploads (RSS, free, no keys).
// Scores every headline, builds a macro mood + per-topic sentiment (rates, gold,
// oil, crypto, recession, war…) that trader/commodities/crypto agents consume.
const { LIVENEWS_MS } = require('../config');

const FEEDS = [
  ['https://www.ft.com/rss/home', 'FT'],
  ['https://www.theguardian.com/uk/business/rss', 'Guardian'],
  ['https://www.economist.com/finance-and-economics/rss.xml', 'Economist'],
  ['http://feeds.bbci.co.uk/news/business/rss.xml', 'BBC'],
  ['https://news.google.com/rss/search?q=site:reuters.com+markets+when:1d&hl=en-GB', 'Reuters'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCIALMKvObZNtJ6AmdCLP7Lg', 'BloombergTV'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCrp_UI8XtuYfpiqluWLD7Lw', 'CNBC-TV'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCEAZeUIeJs0IjQiqTCdVSIg', 'YahooFinance'],
];
const POS_RE = /(surge|rally|soar|jump|gain|bullish|record|boom|upgrade|beat|strong|recover|rebound|breakthrough|deal|stimulus|rate cut)/gi;
const NEG_RE = /(crash|plunge|slump|recession|crisis|war|sanction|default|bankrupt|layoff|downgrade|miss|warn|tariff|inflation surge|rate hike|selloff|collaps|escalat)/gi;
const TOPICS = {
  rates: /interest rate|federal reserve|fed |boe |ecb |central bank|inflation/i,
  gold: /\bgold\b/i, oil: /\boil\b|opec|crude|brent/i, natgas: /natural gas|energy price/i,
  crypto: /bitcoin|crypto|ethereum/i, china: /\bchina\b|beijing/i,
  war: /war|conflict|missile|invasion|strike[s]? on/i, recession: /recession|slowdown|contraction/i,
  tech: /\bai\b|artificial intelligence|chip|semiconductor|tech stocks/i,
  copper: /\bcopper\b/i, silver: /\bsilver\b/i, wheat: /wheat|grain/i,
};

function start(bus) {
  bus.deepNews = { headlines: [], global: 0, perTopic: {}, updated: null, sources: 0 };

  async function rss(url, source) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research)' } });
    const xml = await r.text();
    const out = []; const re = /<title>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/title>/g;
    let m, first = true;
    while ((m = re.exec(xml)) && out.length < 12) {
      if (first) { first = false; continue; }
      out.push({ title: m[1].trim(), source });
    }
    return out;
  }

  async function refresh() {
    const heads = []; let ok = 0;
    for (const [u, s] of FEEDS) { try { const h = await rss(u, s); if (h.length) ok++; heads.push(...h); } catch (e) {} }
    if (!heads.length) return;
    for (const h of heads) h.score = Math.max(-3, Math.min(3, (h.title.match(POS_RE) || []).length - (h.title.match(NEG_RE) || []).length));
    bus.deepNews.headlines = heads.slice(0, 40);
    bus.deepNews.global = +(heads.reduce((a, h) => a + h.score, 0) / heads.length).toFixed(2);
    bus.deepNews.sources = ok;
    const per = {};
    for (const [topic, re] of Object.entries(TOPICS)) {
      const rel = heads.filter(h => re.test(h.title));
      if (rel.length >= 2) per[topic] = +(rel.reduce((a, h) => a + h.score, 0) / rel.length).toFixed(2);
    }
    // war/recession fear is bullish for gold — encode the classic flight-to-safety link
    if ((per.war || 0) < -0.5 || (per.recession || 0) < -0.5) per.gold = +((per.gold || 0) + 0.8).toFixed(2);
    bus.deepNews.perTopic = per;
    bus.deepNews.updated = new Date().toLocaleTimeString();
  }

  refresh(); setInterval(refresh, LIVENEWS_MS);
  console.log(`[livenews] deep-press agent started — ${FEEDS.length} outlets incl. FT/Economist/Bloomberg TV/CNBC video desks`);
}
module.exports = { start };
