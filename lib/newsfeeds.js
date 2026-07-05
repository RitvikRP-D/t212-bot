'use strict';
// GLOBAL FEED REGISTRY — the source list behind the News Radar. Instead of a hand-typed
// list of a few dozen desks, this GENERATES a very large set of distinct, keyless,
// live feeds by crossing every region with its major named outlets and the topics that
// move markets. Every entry is a real RSS/Atom endpoint (direct feed or a Google News
// mirror query, which is itself a live, per-query feed). The radar rotates through them
// in batches so headlines flow continuously without hammering any single host.
//
// Honest note on scale: this yields ~900 distinct live channels. That is deliberately
// NOT "fetch 900 URLs every second" — that gets an IP banned within minutes and would
// return LESS news, not more. The radar sweeps them in rotating batches so each channel
// is polled every few minutes while fresh headlines land on every tick.

// Google-News per-query mirror. hl/gl/ceid localise it to a country/language so a "site:"
// or topic query returns that market's coverage. Each unique URL == one live channel.
function gn(q, hl = 'en-US', gl = 'US', ceid) {
  const c = ceid || `${gl}:${hl.split('-')[0]}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${c}`;
}

// ─────────────────────────── DIRECT NATIVE RSS ───────────────────────────
// Hand-verified feeds that publish their own RSS (fastest + richest when they work).
const DIRECT = [
  ['https://www.ft.com/rss/home', 'FT', 'global'],
  ['https://www.theguardian.com/uk/business/rss', 'Guardian', 'UK'],
  ['https://www.theguardian.com/world/rss', 'Guardian', 'global'],
  ['https://www.economist.com/finance-and-economics/rss.xml', 'Economist', 'global'],
  ['https://www.economist.com/the-world-this-week/rss.xml', 'Economist', 'global'],
  ['http://feeds.bbci.co.uk/news/business/rss.xml', 'BBC', 'UK'],
  ['http://feeds.bbci.co.uk/news/world/rss.xml', 'BBC', 'global'],
  ['https://feeds.marketwatch.com/marketwatch/topstories/', 'MarketWatch', 'US'],
  ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch', 'US'],
  ['https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'WSJmkts', 'US'],
  ['https://feeds.a.dj.com/rss/RSSWorldNews.xml', 'WSJ', 'global'],
  ['https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC', 'US'],
  ['https://www.cnbc.com/id/15839135/device/rss/rss.html', 'CNBCfinance', 'US'],
  ['https://www.cnbc.com/id/19794221/device/rss/rss.html', 'CNBCtech', 'US'],
  ['https://www.cnbc.com/id/100727362/device/rss/rss.html', 'CNBCworld', 'global'],
  ['https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', 'CNBCintl', 'global'],
  ['https://moxie.foxbusiness.com/google-publisher/markets.xml', 'FoxBusiness', 'US'],
  ['https://finance.yahoo.com/news/rssindex', 'YahooFinance', 'US'],
  ['https://seekingalpha.com/market_currents.xml', 'SeekingAlpha', 'US'],
  ['https://www.benzinga.com/feed', 'Benzinga', 'US'],
  ['https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20Room', 'GlobeNewswire', 'global'],
  ['https://www.prnewswire.com/rss/news-releases-list.rss', 'PRNewswire', 'global'],
  ['https://asia.nikkei.com/rss/feed/nar', 'NikkeiAsia', 'ASIA'],
  ['https://www.scmp.com/rss/92/feed', 'SCMP', 'ASIA'],
  ['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'EconomicTimes', 'INDIA'],
  ['https://www.livemint.com/rss/markets', 'LiveMint', 'INDIA'],
  ['https://www.moneycontrol.com/rss/latestnews.xml', 'MoneyControl', 'INDIA'],
  ['https://www.business-standard.com/rss/markets-106.rss', 'BusinessStd', 'INDIA'],
  ['https://www.investing.com/rss/news.rss', 'Investing', 'global'],
  ['https://www.investing.com/rss/news_25.rss', 'InvestingMkt', 'global'],
  ['https://feeds.feedburner.com/zerohedge/feed', 'ZeroHedge', 'global'],
  ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk', 'CRYPTO'],
  ['https://cointelegraph.com/rss', 'CoinTelegraph', 'CRYPTO'],
  ['https://www.theblock.co/rss.xml', 'TheBlock', 'CRYPTO'],
  ['https://decrypt.co/feed', 'Decrypt', 'CRYPTO'],
  ['https://bitcoinmagazine.com/feed', 'BitcoinMag', 'CRYPTO'],
  ['https://techcrunch.com/feed/', 'TechCrunch', 'US'],
  ['https://www.fiercepharma.com/rss/xml', 'FiercePharma', 'US'],
  ['https://www.freightwaves.com/feed', 'FreightWaves', 'US'],
  ['https://www.mining.com/feed/', 'Mining', 'global'],
  ['https://oilprice.com/rss/main', 'OilPrice', 'global'],
  ['https://spacenews.com/feed/', 'SpaceNews', 'US'],
  ['https://www.aljazeera.com/xml/rss/all.xml', 'AlJazeera', 'MENA'],
  ['https://www.channelnewsasia.com/rssfeeds/8395986', 'ChannelNewsAsia', 'SEA'],
  ['https://www.rt.com/rss/business/', 'RT', 'RUSSIA'],
  ['https://tass.com/rss/v2.xml', 'TASS', 'RUSSIA'],
  // Official US government — presidential actions + Trump's own posts
  ['https://www.whitehouse.gov/presidential-actions/feed/', 'WhiteHouse', 'US'],
  ['https://www.whitehouse.gov/briefing-room/feed/', 'WhiteHouse', 'US'],
  ['https://trumpstruth.org/feed', 'TruthSocial', 'US'],
];

// ─────────────────────── REGIONS × NAMED OUTLETS ───────────────────────
// For each region: its locale + the domains of its major business/markets outlets.
// We build a "site:" Google-News channel per outlet (broad) plus a markets-scoped one,
// so each outlet contributes two live channels localised to its market.
const REGIONS = {
  US:     { hl: 'en-US', gl: 'US', outlets: ['wsj.com','bloomberg.com','cnbc.com','reuters.com','forbes.com','businessinsider.com','marketwatch.com','barrons.com','foxbusiness.com','thestreet.com','morningstar.com','fortune.com','axios.com','politico.com','npr.org','nytimes.com','washingtonpost.com','usatoday.com','investors.com','kiplinger.com','thehill.com','yahoo.com'] },
  UK:     { hl: 'en-GB', gl: 'GB', outlets: ['bbc.co.uk','theguardian.com','telegraph.co.uk','thetimes.co.uk','ft.com','cityam.com','thisismoney.co.uk','independent.co.uk','news.sky.com','standard.co.uk','sharecast.com','proactiveinvestors.co.uk','cityindex.com'] },
  EU:     { hl: 'en-US', gl: 'US', outlets: ['dw.com','france24.com','euronews.com','politico.eu','lemonde.fr','handelsblatt.com','spiegel.de','elpais.com','ilsole24ore.com','brusselstimes.com','emerging-europe.com'] },
  INDIA:  { hl: 'en-IN', gl: 'IN', outlets: ['economictimes.indiatimes.com','livemint.com','business-standard.com','moneycontrol.com','thehindubusinessline.com','financialexpress.com','ndtvprofit.com','timesofindia.indiatimes.com','cnbctv18.com','zeebiz.com'] },
  CHINA:  { hl: 'en-US', gl: 'US', outlets: ['scmp.com','caixinglobal.com','globaltimes.cn','chinadaily.com.cn','yicaiglobal.com','xinhuanet.com'] },
  JAPAN:  { hl: 'en-US', gl: 'US', outlets: ['asia.nikkei.com','japantimes.co.jp','mainichi.jp','japan.kyodonews.net','nippon.com'] },
  KOREA:  { hl: 'en-US', gl: 'US', outlets: ['koreaherald.com','koreatimes.co.kr','koreajoongangdaily.joins.com','en.yna.co.kr','businesskorea.co.kr','pulsenews.co.kr'] },
  SEA:    { hl: 'en-SG', gl: 'SG', outlets: ['straitstimes.com','businesstimes.com.sg','channelnewsasia.com','todayonline.com','thejakartapost.com','bangkokpost.com','vnexpress.net','thestar.com.my'] },
  AU:     { hl: 'en-AU', gl: 'AU', outlets: ['afr.com','abc.net.au','smh.com.au','theaustralian.com.au','news.com.au','businessnews.com.au','bnnbloomberg.ca'] },
  RUSSIA: { hl: 'en-US', gl: 'US', outlets: ['themoscowtimes.com','tass.com','rt.com','interfax.com','bne.eu'] },
  MENA:   { hl: 'en-US', gl: 'US', outlets: ['aljazeera.com','arabnews.com','gulfnews.com','thenationalnews.com','zawya.com','ameinfo.com'] },
  LATAM:  { hl: 'en-US', gl: 'US', outlets: ['batimes.com.ar','riotimesonline.com','mercopress.com','bnamericas.com'] },
};

// Topics that move prices — applied globally and per-region.
const TOPICS = [
  'stock market', 'stocks', 'central bank', 'interest rates', 'inflation', 'earnings',
  'economy', 'commodities', 'oil price', 'gold price', 'supply chain', 'trade war',
  'tariffs', 'semiconductors', 'artificial intelligence', 'cryptocurrency', 'mergers acquisitions',
  'IPO', 'banking', 'bond yields', 'recession', 'GDP', 'unemployment', 'energy',
  'electric vehicles', 'defense stocks', 'shipping rates', 'housing market',
];

// Crypto gets its own dense lane — it never sleeps and the account can always trade ETPs.
const CRYPTO_TOPICS = ['bitcoin', 'ethereum', 'solana', 'crypto regulation', 'crypto ETF', 'stablecoin', 'DeFi', 'crypto hack', 'bitcoin ETF flows', 'altcoin'];

// Everything Trump — a dense dedicated lane (posts, policy, and what he/family own).
const TRUMP_QUERIES = [
  '"Donald Trump"', 'Trump tariffs', 'Trump trade', 'Trump executive order', 'Trump Fed OR Powell',
  'Trump China', 'Trump oil OR energy', 'Trump crypto', 'Trump stocks OR market', 'White House Treasury',
  '"Trump Media" OR "DJT stock"', '"World Liberty Financial" OR WLFI', '"$TRUMP" coin',
  '"Trump Organization" deal OR stake', 'Trump family invests OR buys OR sells', 'Truth Social Trump post',
];

function build() {
  const feeds = [];
  const seen = new Set();
  const add = (u, s, r) => { if (seen.has(u)) return; seen.add(u); feeds.push([u, s, r]); };

  for (const [u, s, r] of DIRECT) add(u, s, r);

  // Regions × outlets (3 scopes each) and every topic localised per region
  const bigRegions = ['US', 'UK', 'INDIA', 'EU', 'SEA', 'AU'];
  for (const [region, cfg] of Object.entries(REGIONS)) {
    for (const dom of cfg.outlets) {
      const label = dom.replace(/^www\.|\.(com|co\.uk|org|net|cn|jp|kr|sg|in|eu|fr|de|es|it|ar)$/g, '').split('.')[0];
      // MARKET-SCOPED ONLY — a bare site: query pulls an outlet's ENTIRE feed (sport,
      // lifestyle, quizzes…). Scoping every channel to money keywords keeps the radar
      // relevant instead of drowning real signal in fluff.
      add(gn(`site:${dom} (stocks OR shares OR markets OR economy OR earnings) when:2d`, cfg.hl, cfg.gl), cap(label), region);
      add(gn(`site:${dom} (business OR finance OR trading OR investors OR "central bank") when:2d`, cfg.hl, cfg.gl), cap(label), region);
      add(gn(`site:${dom} (analysis OR forecast OR outlook OR guidance OR results) when:2d`, cfg.hl, cfg.gl), cap(label), region);
    }
    // every market-moving topic, localised to this region
    for (const t of TOPICS) add(gn(`${t} when:1d`, cfg.hl, cfg.gl), 'GNews·' + region, region);
    // biggest regions also get an English-global locale pass for breadth
    if (bigRegions.includes(region)) for (const t of TOPICS) add(gn(`${region} ${t} when:1d`, 'en-US', 'US'), 'GNews·' + region, region);
  }

  // Global topic channels (en-US + en-GB duals for breadth)
  for (const t of TOPICS) {
    add(gn(`${t} when:1d`, 'en-US', 'US'), 'GNews', 'global');
    add(gn(`${t} when:1d`, 'en-GB', 'GB'), 'GNews', 'global');
  }

  // Crypto lane
  for (const t of CRYPTO_TOPICS) add(gn(`${t} when:1d`, 'en-US', 'US'), 'GNews·crypto', 'CRYPTO');

  // Trump lane
  for (const q of TRUMP_QUERIES) add(gn(`${q} when:2d`, 'en-US', 'US'), 'TrumpDesk', 'US');
  add('https://trumpstruth.org/feed', 'TruthSocial', 'US');

  return feeds;
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const FEEDS = build();
module.exports = { FEEDS, count: FEEDS.length };
