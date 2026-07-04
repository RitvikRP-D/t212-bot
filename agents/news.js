'use strict';
// AGENT ②: news + sentiment + congressional trading disclosures (stock-focused, free sources).
// Scoring now runs through lib/sentiment (weighted, negation-aware, source-weighted).
// Congress boost is recency-decayed, trade-size weighted and cluster-aware.
const { NEWS_MS, CONGRESS_MS } = require('../config');
const { scoreHeadline, amountWeight } = require('../lib/sentiment');
const { fetchHeadlines } = require('../lib/feeds');

function start(bus) {
  bus.news = { fng: { value: null, label: '' }, headlines: [], global: 0, perKey: {}, congress: [], congressBoost: {}, congressTop: [], updated: null, congressUpdated: null, feedsOk: 0 };
  const reCache = new Map();   // compiled per-symbol headline matchers, built once

  async function refresh() {
    const heads = [];
    try {
      const j = await (await fetch('https://api.alternative.me/fng/?limit=1')).json();
      bus.news.fng = { value: parseInt(j.data[0].value), label: j.data[0].value_classification };
    } catch (e) {}
    const feeds = [
      ['https://feeds.marketwatch.com/marketwatch/realtimeheadlines/', 'MarketWatch'],
      ['https://feeds.a.dj.com/rss/RSSMarketsMain.xml', 'WSJ'],
      ['https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC'],
      ['https://finance.yahoo.com/news/rssindex', 'YahooFinance'],
      ['https://news.google.com/rss/search?q=stock+market+when:1d&hl=en-GB&gl=GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=earnings+OR+guidance+when:1d&hl=en-US', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=federal+reserve+OR+interest+rates+OR+inflation+when:1d&hl=en-GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=FTSE+OR+"European+stocks"+when:1d&hl=en-GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=upgrade+OR+downgrade+analyst+price+target+when:1d&hl=en-US', 'GoogleNews'],
    ];
    let ok = 0;
    for (const [u, s] of feeds) { try { const h = await fetchHeadlines(u, s); if (h.length) ok++; heads.push(...h); } catch (e) {} }
    bus.news.feedsOk = ok;
    if (!heads.length) return;
    for (const h of heads) h.score = scoreHeadline(h.title, h.source);
    bus.news.headlines = heads;
    // global mood weighted toward stronger-conviction headlines
    const strong = heads.filter(h => Math.abs(h.score) > 0.3);
    bus.news.global = +((strong.length ? strong : heads).reduce((a, h) => a + h.score, 0) / (strong.length || heads.length)).toFixed(2);
    const perKey = {};
    for (const u of bus.universe) {
      let re = reCache.get(u.y);
      if (re === undefined) {
        const base = u.y.split('.')[0].replace('-', '\\.');
        try { re = new RegExp(`\\b(${u.name.split('|')[0].replace(/[^\w &|-]/g, '')}|${base})\\b`, 'i'); }
        catch (e) { re = null; }
        reCache.set(u.y, re);
      }
      if (!re) continue;
      const rel = heads.filter(h => re.test(h.title));
      if (rel.length) perKey[u.y] = +(rel.reduce((a, h) => a + h.score, 0) / rel.length).toFixed(2);
    }
    bus.news.perKey = perKey;
    bus.news.updated = new Date().toLocaleTimeString();
  }

  async function refreshCongress() {
    const trades = [];
    const now = Date.now();
    const cutoff = now - 60 * 86400e3;
    // Free, currently-maintained mirrors (the old S3 buckets went 403). House repo is
    // live (incl. Pelosi et al.); senate S3 kept as best-effort in case it returns.
    for (const u of [
      'https://raw.githubusercontent.com/TattooedHead/house-stock-watcher-data/main/data/all_transactions.json',
      'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
    ]) {
      try {
        const j = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
        if (!Array.isArray(j)) continue;
        for (const t of j) {
          const d = new Date(t.transaction_date || t.disclosure_date || 0).getTime();
          // d <= now drops malformed future-dated rows that would otherwise get max recency weight
          if (d > cutoff && d <= now && t.ticker && t.ticker !== '--') {
            trades.push({
              ticker: t.ticker.trim().toUpperCase(),
              who: t.senator || t.representative || '?',
              type: (t.type || '').toLowerCase(),
              date: t.transaction_date || t.disclosure_date,
              amount: t.amount || '', when: d,
            });
          }
        }
      } catch (e) {}
    }
    if (!trades.length) return;
    // recency-decayed, size-weighted signal + distinct-buyer clustering
    const agg = {};   // ticker -> { score, buyers:Set, buys, sells }
    for (const t of trades) {
      const a = agg[t.ticker] = agg[t.ticker] || { score: 0, buyers: new Set(), buys: 0, sells: 0 };
      const ageDays = Math.max(0, (now - t.when) / 86400e3);
      const recency = Math.exp(-ageDays / 30);          // ~1.0 today → 0.37 @30d → 0.14 @60d
      const size = amountWeight(t.amount);
      if (t.type.includes('purchase')) { a.score += 1.0 * recency * size; a.buyers.add(t.who); a.buys++; }
      else if (t.type.includes('sale')) { a.score -= 0.6 * recency * size; a.sells++; }
    }
    const boost = {};
    const ranked = [];
    for (const [tk, a] of Object.entries(agg)) {
      // conviction cluster: several different politicians buying the same name amplifies it
      const cluster = a.buyers.size >= 3 ? 1.5 : a.buyers.size === 2 ? 1.2 : 1.0;
      const val = +(a.score * cluster).toFixed(2);
      boost[tk] = val;
      if (Math.abs(val) >= 0.4) ranked.push({ ticker: tk, val, buyers: a.buyers.size, buys: a.buys, sells: a.sells });
    }
    ranked.sort((x, y) => y.val - x.val);
    bus.news.congress = trades.slice(-100).reverse();
    bus.news.congressBoost = boost;
    bus.news.congressTop = ranked.slice(0, 15);
    bus.news.congressUpdated = new Date().toLocaleTimeString();
  }
  refresh(); setInterval(refresh, NEWS_MS);
  refreshCongress(); setInterval(refreshCongress, CONGRESS_MS);
  console.log('[news] agent started');
}
module.exports = { start };
