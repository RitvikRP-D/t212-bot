'use strict';
// AGENT ⑬: DEEP NEWS — reads the serious press 24/7: Financial Times, The Guardian,
// The Economist, BBC Business, Reuters wire (via Google), plus the video desks —
// Bloomberg TV, CNBC and Yahoo Finance YouTube uploads (RSS, free, no keys).
// Scores every headline, builds a macro mood + per-topic sentiment (rates, gold,
// oil, crypto, recession, war…) that trader/commodities/crypto agents consume.
const { LIVENEWS_MS } = require('../config');
const { scoreHeadline } = require('../lib/sentiment');
const { fetchHeadlines } = require('../lib/feeds');

const FEEDS = [
  ['https://www.ft.com/rss/home', 'FT'],
  ['https://www.theguardian.com/uk/business/rss', 'Guardian'],
  ['https://www.economist.com/finance-and-economics/rss.xml', 'Economist'],
  ['http://feeds.bbci.co.uk/news/business/rss.xml', 'BBC'],
  ['https://news.google.com/rss/search?q=site:reuters.com+markets+when:1d&hl=en-GB', 'Reuters'],
  ['https://news.google.com/rss/search?q=site:bloomberg.com+markets+when:1d&hl=en-GB', 'Bloomberg'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCIALMKvObZNtJ6AmdCLP7Lg', 'BloombergTV'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCrp_UI8XtuYfpiqluWLD7Lw', 'CNBC-TV'],
  ['https://www.youtube.com/feeds/videos.xml?channel_id=UCEAZeUIeJs0IjQiqTCdVSIg', 'YahooFinance'],
];
const TOPICS = {
  rates: /interest rate|federal reserve|\bfed\b|\bboe\b|\becb\b|central bank|inflation|cpi|jobs report|payroll/i,
  gold: /\bgold\b|bullion/i, oil: /\boil\b|opec|crude|brent|wti/i, natgas: /natural gas|energy price/i,
  crypto: /bitcoin|crypto|ethereum|\bbtc\b|\beth\b/i, china: /\bchina\b|beijing|yuan|pboc/i,
  war: /\bwar\b|conflict|missile|invasion|strike[s]? on|geopolit/i, recession: /recession|slowdown|contraction|hard landing/i,
  tech: /\bai\b|artificial intelligence|\bchip\b|semiconductor|tech stocks|nvidia/i,
  copper: /\bcopper\b/i, silver: /\bsilver\b/i, wheat: /wheat|grain|corn|soybean/i,
  banks: /\bbank(s|ing)?\b|credit|lending|financial sector/i,
};

function start(bus) {
  bus.deepNews = { headlines: [], global: 0, perTopic: {}, updated: null, sources: 0 };

  async function refresh() {
    const heads = []; let ok = 0;
    for (const [u, s] of FEEDS) { try { const h = await fetchHeadlines(u, s, 12); if (h.length) ok++; heads.push(...h); } catch (e) {} }
    if (!heads.length) return;
    for (const h of heads) h.score = scoreHeadline(h.title, h.source);
    bus.deepNews.headlines = heads.slice(0, 40);
    const strong = heads.filter(h => Math.abs(h.score) > 0.3);
    bus.deepNews.global = +((strong.length ? strong : heads).reduce((a, h) => a + h.score, 0) / (strong.length || heads.length)).toFixed(2);
    bus.deepNews.sources = ok;
    const per = {};
    for (const [topic, re] of Object.entries(TOPICS)) {
      const rel = heads.filter(h => re.test(h.title));
      // single strong hit still counts (weighted); noise needs corroboration
      if (rel.length >= 2 || (rel.length === 1 && Math.abs(rel[0].score) >= 1.5)) {
        per[topic] = +(rel.reduce((a, h) => a + h.score, 0) / rel.length).toFixed(2);
      }
    }
    // war/recession fear is bullish for gold — encode the classic flight-to-safety link
    if ((per.war || 0) < -0.5 || (per.recession || 0) < -0.5) per.gold = +((per.gold || 0) + 0.8).toFixed(2);
    // hawkish rates (inflation/hike fear) pressures tech & gold; dovish (cuts) lifts both
    if (per.rates != null) { per.tech = +((per.tech || 0) + per.rates * 0.3).toFixed(2); }
    bus.deepNews.perTopic = per;
    bus.deepNews.updated = new Date().toLocaleTimeString();
  }

  refresh(); setInterval(refresh, LIVENEWS_MS);
  console.log(`[livenews] deep-press agent started — ${FEEDS.length} outlets incl. FT/Economist/Bloomberg TV/CNBC video desks`);
}
module.exports = { start };
