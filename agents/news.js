'use strict';
// AGENT ②: news + sentiment + congressional trading disclosures (stock-focused, free sources).
const { NEWS_MS, CONGRESS_MS } = require('../config');

const POS_RE = /(surge|rally|soar|jump|gain|bullish|record|all-time high|adopt|approv|institutional|breakout|upgrade|beat[s]? (estimates|expectations)|partnership|buyback|dividend raise|strong (earnings|results)|guidance raise|recover|rebound)/gi;
const NEG_RE = /(crash|plunge|dump|hack|breach|ban|lawsuit|sue[sd]?|fraud|scam|selloff|bearish|collaps|warn|miss(es|ed)? (estimates|expectations)|downgrade|layoff|recall|probe|investigat|bankrupt|default|tumble|slump|sink|guidance cut)/gi;

function score(t) {
  const p = (t.match(POS_RE) || []).length, n = (t.match(NEG_RE) || []).length;
  return Math.max(-3, Math.min(3, p - n));
}
async function rss(url, source) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research)' } });
  const xml = await r.text();
  const out = []; const re = /<title>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/title>/g;
  let m, first = true;
  while ((m = re.exec(xml)) && out.length < 15) {
    if (first) { first = false; continue; }
    out.push({ title: m[1].trim(), source });
  }
  return out;
}

function start(bus) {
  bus.news = { fng: { value: null, label: '' }, headlines: [], global: 0, perKey: {}, congress: [], congressBoost: {}, updated: null, congressUpdated: null };

  async function refresh() {
    const heads = [];
    try {
      const j = await (await fetch('https://api.alternative.me/fng/?limit=1')).json();
      bus.news.fng = { value: parseInt(j.data[0].value), label: j.data[0].value_classification };
    } catch (e) {}
    const feeds = [
      ['https://feeds.marketwatch.com/marketwatch/topstories/', 'MarketWatch'],
      ['https://news.google.com/rss/search?q=stock+market+when:1d&hl=en-GB&gl=GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=earnings+OR+guidance+when:1d&hl=en-US', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=federal+reserve+OR+interest+rates+OR+inflation+when:1d&hl=en-GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=FTSE+OR+"European+stocks"+when:1d&hl=en-GB', 'GoogleNews'],
    ];
    for (const [u, s] of feeds) { try { heads.push(...await rss(u, s)); } catch (e) {} }
    if (!heads.length) return;
    for (const h of heads) h.score = score(h.title);
    bus.news.headlines = heads;
    bus.news.global = +(heads.reduce((a, h) => a + h.score, 0) / heads.length).toFixed(2);
    const perKey = {};
    for (const u of bus.universe) {
      const base = u.y.split('.')[0].replace('-', '\\.');
      let re;
      try { re = new RegExp(`\\b(${u.name.split('|')[0].replace(/[^\w &|-]/g, '')}|${base})\\b`, 'i'); } catch (e) { continue; }
      const rel = heads.filter(h => re.test(h.title));
      if (rel.length) perKey[u.y] = +(rel.reduce((a, h) => a + h.score, 0) / rel.length).toFixed(2);
    }
    bus.news.perKey = perKey;
    bus.news.updated = new Date().toLocaleTimeString();
  }

  async function refreshCongress() {
    const trades = [];
    for (const u of [
      'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
      'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    ]) {
      try {
        const j = await (await fetch(u)).json();
        const cutoff = Date.now() - 60 * 86400e3;
        for (const t of j) {
          const d = new Date(t.transaction_date || t.disclosure_date || 0).getTime();
          if (d > cutoff && t.ticker && t.ticker !== '--') trades.push({ ticker: t.ticker.trim().toUpperCase(), who: t.senator || t.representative || '?', type: (t.type || '').toLowerCase(), date: t.transaction_date });
        }
      } catch (e) {}
    }
    if (trades.length) {
      const boost = {};
      for (const t of trades) {
        if (t.type.includes('purchase')) boost[t.ticker] = (boost[t.ticker] || 0) + 1;
        if (t.type.includes('sale')) boost[t.ticker] = (boost[t.ticker] || 0) - 0.5;
      }
      bus.news.congress = trades.slice(-100).reverse();
      bus.news.congressBoost = boost;
      bus.news.congressUpdated = new Date().toLocaleTimeString();
    }
  }
  refresh(); setInterval(refresh, NEWS_MS);
  refreshCongress(); setInterval(refreshCongress, CONGRESS_MS);
  console.log('[news] agent started');
}
module.exports = { start };
