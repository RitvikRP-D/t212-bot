'use strict';
// AGENT: GLOBAL NEWS RADAR — the always-on, everything-everywhere collector.
// Runs 24/7 and pulls from the serious financial press, the wires, the political
// desks, and Donald Trump's own posts (Truth Social bridge + every outlet quoting
// him), across the US, UK, Europe and Asia. It does NOT pre-filter to "market news"
// — it takes EVERYTHING (politics, geopolitics, tech, energy, corporate, macro) so
// nothing that could move a price is missed, then tags each item with region,
// entities (Trump, Fed, China, OPEC…) and market relevance for the brain agent.
//
// Free + keyless: every source is a public RSS/Atom feed. No API keys, no limits.
const { scoreHeadline } = require('../lib/sentiment');
const { fetchHeadlines } = require('../lib/feeds');

const RADAR_MS = 60000;   // sweep every 60s, 24/7 (news never sleeps)

// —— SOURCES —— grouped by desk; each is [url, sourceLabel, region]
const SOURCES = [
  // Serious financial press
  ['https://www.ft.com/rss/home', 'FT', 'global'],
  ['https://www.theguardian.com/uk/business/rss', 'Guardian', 'UK'],
  ['https://www.theguardian.com/world/rss', 'Guardian', 'global'],
  ['https://www.economist.com/finance-and-economics/rss.xml', 'Economist', 'global'],
  ['https://www.economist.com/the-world-this-week/rss.xml', 'Economist', 'global'],
  ['http://feeds.bbci.co.uk/news/business/rss.xml', 'BBC', 'UK'],
  ['http://feeds.bbci.co.uk/news/world/rss.xml', 'BBC', 'global'],
  // Wires (via Google News mirrors — always reachable, keyless)
  ['https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-GB', 'Reuters', 'global'],
  ['https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US', 'AP', 'global'],
  ['https://news.google.com/rss/search?q=site:bloomberg.com+when:1d&hl=en-GB', 'Bloomberg', 'global'],
  ['https://feeds.marketwatch.com/marketwatch/topstories/', 'MarketWatch', 'US'],
  ['https://feeds.a.dj.com/rss/RSSWorldNews.xml', 'WSJ', 'global'],
  ['https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC', 'US'],
  ['https://finance.yahoo.com/news/rssindex', 'YahooFinance', 'US'],
  // —— POLITICS + TRUMP —— his posts move tariffs, oil, defence, crypto, china
  ['https://trumpstruth.org/feed', 'TruthSocial', 'US'],                                   // Trump's Truth Social archive (best-effort)
  ['https://news.google.com/rss/search?q=%22Donald+Trump%22+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=Trump+tariffs+OR+trade+OR+executive+order+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=Trump+stocks+OR+market+OR+fed+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=White+House+OR+Treasury+OR+tariff+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=congress+OR+senate+stock+trades+when:2d&hl=en-US', 'GoogleNews', 'US'],
  // —— MACRO / CENTRAL BANKS ——
  ['https://news.google.com/rss/search?q=federal+reserve+OR+interest+rates+OR+inflation+OR+cpi+when:1d&hl=en-GB', 'GoogleNews', 'global'],
  ['https://news.google.com/rss/search?q=ECB+OR+bank+of+england+OR+rate+decision+when:1d&hl=en-GB', 'GoogleNews', 'EU'],
  // —— ASIA / EMERGING ——
  ['https://news.google.com/rss/search?q=china+economy+OR+PBOC+OR+yuan+when:1d&hl=en', 'GoogleNews', 'ASIA'],
  ['https://news.google.com/rss/search?q=japan+OR+nikkei+OR+bank+of+japan+when:1d&hl=en', 'GoogleNews', 'ASIA'],
  ['https://news.google.com/rss/search?q=%22Asian+markets%22+OR+hang+seng+OR+sensex+when:1d&hl=en', 'GoogleNews', 'ASIA'],
  // —— SECTOR / COMMODITY / CRYPTO ——
  ['https://news.google.com/rss/search?q=oil+OR+opec+OR+brent+OR+crude+when:1d&hl=en-GB', 'GoogleNews', 'global'],
  ['https://news.google.com/rss/search?q=gold+OR+silver+OR+copper+price+when:1d&hl=en-GB', 'GoogleNews', 'global'],
  ['https://news.google.com/rss/search?q=bitcoin+OR+crypto+OR+ethereum+when:1d&hl=en', 'GoogleNews', 'global'],
  ['https://news.google.com/rss/search?q=earnings+OR+guidance+OR+profit+warning+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=merger+OR+acquisition+OR+buyout+when:1d&hl=en-US', 'GoogleNews', 'US'],
  ['https://news.google.com/rss/search?q=geopolitics+OR+war+OR+sanctions+OR+conflict+when:1d&hl=en-GB', 'GoogleNews', 'global'],

  // ═══ TIER 2 — the top-100 desks (user-curated), all verified live RSS ═══
  // Live broadcast networks
  ['https://moxie.foxbusiness.com/google-publisher/markets.xml', 'FoxBusiness', 'US'],
  ['https://www.cnbc.com/id/15839135/device/rss/rss.html', 'CNBCfinance', 'US'],
  ['https://www.cnbc.com/id/19794221/device/rss/rss.html', 'CNBCtech', 'US'],
  ['https://www.cnbc.com/id/100727362/device/rss/rss.html', 'CNBCworld', 'global'],
  ['https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', 'CNBCintl', 'global'],
  ['https://news.google.com/rss/search?q=site:cnbctv18.com+when:1d&hl=en-IN', 'CNBCTV18', 'ASIA'],
  // Wires + breaking + press releases (earnings/M&A/regulatory land here first)
  ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch', 'US'],
  ['https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'WSJmkts', 'US'],
  ['https://seekingalpha.com/market_currents.xml', 'SeekingAlpha', 'US'],
  ['https://www.benzinga.com/feed', 'Benzinga', 'US'],
  ['https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20Room', 'GlobeNewswire', 'global'],
  ['https://www.prnewswire.com/rss/news-releases-list.rss', 'PRNewswire', 'global'],
  ['https://news.google.com/rss/search?q=site:thestreet.com+when:1d&hl=en-US', 'TheStreet', 'US'],
  // Premium newspapers & journals
  ['https://asia.nikkei.com/rss/feed/nar', 'NikkeiAsia', 'ASIA'],
  ['https://www.nytimes.com/svc/collections/v1/publish/https://www.nytimes.com/section/business/rss.xml', 'NYTBusiness', 'US'],
  ['https://www.scmp.com/rss/92/feed', 'SCMP', 'ASIA'],
  ['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'EconomicTimes', 'ASIA'],
  ['https://www.livemint.com/rss/markets', 'LiveMint', 'ASIA'],
  // Digital analysis / macro / contrarian
  ['https://www.investing.com/rss/news.rss', 'Investing', 'global'],
  ['https://www.investing.com/rss/news_25.rss', 'InvestingMkt', 'global'],
  ['https://feeds.feedburner.com/zerohedge/feed', 'ZeroHedge', 'global'],
  // Sector authorities — crypto / tech / energy / pharma / logistics / space / mining
  ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk', 'global'],
  ['https://cointelegraph.com/rss', 'CoinTelegraph', 'global'],
  ['https://www.theblock.co/rss.xml', 'TheBlock', 'global'],
  ['https://techcrunch.com/feed/', 'TechCrunch', 'US'],
  ['https://www.fiercepharma.com/rss/xml', 'FiercePharma', 'US'],
  ['https://www.freightwaves.com/feed', 'FreightWaves', 'US'],
  ['https://www.mining.com/feed/', 'Mining', 'global'],
  ['https://spacenews.com/feed/', 'SpaceNews', 'US'],
];

// Entities we tag on every headline — the brain agent + trader use these to route impact.
const ENTITIES = {
  trump: /\btrump\b|truth social|maga|potus|white house/i,
  fed: /federal reserve|\bfed\b|\bfomc\b|powell|rate (cut|hike|decision)|interest rate/i,
  ecb: /\becb\b|lagarde|european central bank/i,
  boe: /bank of england|\bboe\b|threadneedle/i,
  china: /\bchina\b|beijing|\bpboc\b|\byuan\b|xi jinping|hang seng/i,
  opec: /\bopec\b|saudi|crude|oil output|barrel/i,
  war: /\bwar\b|missile|invasion|conflict|sanction|strike[s]?\b|geopolit/i,
  tariff: /tariff|trade war|import tax|export ban|customs/i,
  ai: /\bai\b|artificial intelligence|nvidia|chatgpt|semiconductor|\bchip[s]?\b/i,
  crypto: /bitcoin|crypto|ethereum|\bbtc\b|\beth\b|coinbase/i,
  recession: /recession|slowdown|hard landing|contraction|layoff/i,
  earnings: /earnings|guidance|profit warning|beats estimates|misses estimates/i,
  mna: /merger|acquisition|buyout|takeover|acquire[sd]?/i,
};

function start(bus) {
  bus.newsRadar = {
    headlines: [], byRegion: {}, byEntity: {}, bySource: {},
    global: 0, trumpFeed: [], sources: 0, total: 0, updated: null,
  };
  const seen = new Set();   // de-dupe by title across sweeps
  let sweeping = false;     // overlap guard — never stack sweeps
  let sweepNo = 0;

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try { await doSweep(); } finally { sweeping = false; }
  }

  async function doSweep() {
    if (bus.beat) bus.beat('newsradar');
    const fresh = [];
    let ok = 0, fails = 0;
    const at = Date.now();
    sweepNo++;
    // ALL feeds in parallel — a slow/dead feed costs 12s (its own timeout), not the sweep
    const results = await Promise.allSettled(SOURCES.map(([url, source]) => fetchHeadlines(url, source, 15)));
    results.forEach((res, i) => {
      const [, source, region] = SOURCES[i];
      if (res.status !== 'fulfilled') { fails++; return; }
      if (res.value.length) ok++;
      for (const it of res.value) {
        const key = it.title.slice(0, 80).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const score = scoreHeadline(it.title, source);
        const entities = [];
        for (const [name, re] of Object.entries(ENTITIES)) if (re.test(it.title)) entities.push(name);
        fresh.push({ title: it.title, source, region, score, entities, at });
      }
    });
    // liveness is visible even on a quiet sweep; log health early + periodically
    bus.newsRadar.sources = ok;
    bus.newsRadar.updated = new Date().toLocaleTimeString();
    if (sweepNo <= 3 || sweepNo % 30 === 0 || (ok === 0 && fails > 0)) {
      console.log(`[newsradar] sweep #${sweepNo}: ${ok}/${SOURCES.length} feeds ok, ${fails} failed, ${fresh.length} new headlines`);
    }
    // keep the seen-set from growing forever
    if (seen.size > 4000) { seen.clear(); }

    if (fresh.length) {
      const all = [...fresh, ...bus.newsRadar.headlines].slice(0, 400);   // rolling window
      bus.newsRadar.headlines = all;
      bus.newsRadar.total = all.length;
      bus.newsRadar.sources = ok;

      // macro mood: strong-conviction weighted
      const strong = all.filter(h => Math.abs(h.score) > 0.3);
      bus.newsRadar.global = +((strong.length ? strong : all).reduce((a, h) => a + h.score, 0) / (strong.length || all.length || 1)).toFixed(2);

      // aggregate by region / entity / source (mean score)
      const agg = (keyFn) => {
        const m = {};
        for (const h of all) { for (const k of [].concat(keyFn(h))) { (m[k] = m[k] || []).push(h.score); } }
        const out = {};
        for (const [k, arr] of Object.entries(m)) out[k] = { n: arr.length, score: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) };
        return out;
      };
      bus.newsRadar.byRegion = agg(h => h.region);
      bus.newsRadar.byEntity = agg(h => h.entities.length ? h.entities : []);
      bus.newsRadar.bySource = agg(h => h.source);

      // dedicated Trump lane — his posts + everything quoting him, newest first
      bus.newsRadar.trumpFeed = all.filter(h => h.entities.includes('trump') || h.source === 'TruthSocial').slice(0, 25);

      bus.newsRadar.updated = new Date().toLocaleTimeString();
    }
  }

  sweep(); setInterval(sweep, RADAR_MS);
  console.log(`[newsradar] global 24/7 news radar armed — ${SOURCES.length} feeds (FT/Guardian/Economist/Reuters/AP/Bloomberg + Trump/Truth Social + Asia/EU/US politics)`);
}
module.exports = { start };
