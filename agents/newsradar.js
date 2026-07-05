'use strict';
// AGENT: GLOBAL NEWS RADAR — the always-on, everything-everywhere collector.
// Pulls from ~700 live channels (lib/newsfeeds) spanning the US, UK, Europe, India,
// China, Japan, Korea, SE-Asia, Australia, Russia, the Gulf and Latin America, plus a
// dense Trump lane and a crypto lane. It does NOT pre-filter to "market news" — it takes
// EVERYTHING (politics, geopolitics, tech, energy, corporate, macro) so nothing that can
// move a price is missed, then tags each item with region + entities for the brain.
//
// Why it now feels ALIVE: instead of hitting every feed on a slow 60s clock (which got a
// thin trickle), it rotates the ~700 channels in small batches every few seconds — so
// fresh headlines land continuously while no single host is hammered.
const { scoreHeadline } = require('../lib/sentiment');
const { fetchHeadlines } = require('../lib/feeds');
const { FEEDS } = require('../lib/newsfeeds');

const BATCH_MS = 5000;     // fire one batch every 5s → continuous flow
const BATCH_SIZE = 45;     // feeds per batch (bounded concurrency)
const WINDOW = 1500;       // rolling headline window
const TTL = 6 * 3600e3;    // a headline stays in the window up to 6h

// Trump-linked tradeable assets — the correlator matches these to T212's universe.
const TRUMP_ASSETS = [
  { sym: 'DJT', name: 'Trump Media & Technology (Truth Social)', why: 'majority owned by Trump' },
  { sym: 'COIN', name: 'Coinbase', why: 'proxy for his pro-crypto policy + family crypto ventures' },
  { sym: 'BTC-ETP', name: 'Bitcoin ETPs', why: 'World Liberty Financial + $TRUMP coin make him crypto-aligned' },
  { sym: 'CL-OIL', name: 'Energy / oil names', why: 'drill-baby-drill policy beneficiaries' },
];

// Entities tagged on every headline — the brain + trader route impact by these.
const ENTITIES = {
  trump: /\btrump\b|truth social|maga|potus|white house/i,
  fed: /federal reserve|\bfed\b|\bfomc\b|powell|rate (cut|hike|decision)|interest rate/i,
  ecb: /\becb\b|lagarde|european central bank/i,
  boe: /bank of england|\bboe\b|threadneedle/i,
  china: /\bchina\b|beijing|\bpboc\b|\byuan\b|xi jinping|hang seng/i,
  opec: /\bopec\b|saudi|crude|oil output|barrel|brent|\bwti\b/i,
  war: /\bwar\b|missile|invasion|conflict|sanction|air ?strike|\bstrike[s]?\b|geopolit|military|troops|ceasefire|nuclear/i,
  tariff: /tariff|trade war|import tax|export ban|customs|trade deal/i,
  ai: /\bai\b|artificial intelligence|nvidia|chatgpt|semiconductor|\bchip[s]?\b|data ?cent(er|re)/i,
  crypto: /bitcoin|crypto|ethereum|\bbtc\b|\beth\b|coinbase|stablecoin|\bxrp\b|solana/i,
  gold: /\bgold\b|bullion|precious metal|safe ?haven/i,
  commodity: /\bcommodit|crude|\bwti\b|brent|\bopec\b|natural gas|\bsilver\b|platinum|palladium|\bcopper\b|aluminium|aluminum|\bnickel\b|\bzinc\b|iron ore|\bwheat\b|\bcorn\b|soybean|\bcoffee\b|\bcocoa\b|\bsugar\b|\bcotton\b|lithium|uranium|rare earth|battery metal/i,
  defense: /defen[cs]e|missile|weapon|military spend|nato|arms deal|lockheed|raytheon/i,
  shipping: /red sea|suez|shipping|freight|tanker|strait of hormuz|container/i,
  recession: /recession|slowdown|hard landing|contraction|layoff|jobless/i,
  earnings: /earnings|guidance|profit warning|beats estimates|misses estimates|revenue/i,
  mna: /merger|acquisition|buyout|takeover|acquire[sd]?/i,
};

// MARKET-RELEVANCE gate. Google-News mirrors sometimes leak an outlet's non-money items
// (sport, lifestyle, quizzes). A headline is kept only if it reads like market/econ/policy
// news — it names a tagged entity, OR hits this money lexicon, OR carries a $/£/€/% figure.
const MONEY = /\b(stock|shares?|equit|market|econom|earnings|revenue|profit|guidance|dividend|ipo|merger|acquisition|buyout|nasdaq|dow|s&p|ftse|nikkei|dax|sensex|hang seng|gdp|inflation|cpi|rate cut|rate hike|interest rate|central bank|fed|ecb|treasury|bond|yield|tariff|trade deal|oil|crude|brent|opec|gold|copper|commodit|bitcoin|crypto|ethereum|currency|dollar|euro|yen|yuan|rupee|forex|bank|hedge fund|valuation|analyst|upgrade|downgrade|price target|quarter|fiscal|recession|layoff|jobs report|unemployment|semiconductor|chip|\bAI\b)\b/i;
const MONEYSYM = /[$£€]\s?\d|\d+(\.\d+)?\s?(%|bn|billion|million|trillion|bps)/i;
function marketRelevant(title, entities) {
  if (entities && entities.length) return true;                 // already themed (fed/war/crypto/…)
  return MONEY.test(title) || MONEYSYM.test(title);
}

// WAR / GEOPOLITICS → COMMODITY & SECTOR playbook. When conflict flares, this is the
// chain of consequence the desk narrates and maps onto tradeable names.
const WAR_CHAINS = [
  { when: /oil|crude|brent|opec|hormuz|energy|pipeline/i, commodity: 'Crude oil ↑', up: ['XOM', 'CVX', 'SHEL.L', 'BP.L', 'TTE.PA', 'OXY'], down: ['IAG.L', 'DAL', 'UAL'], why: 'supply-risk premium lifts producers, squeezes airlines/fuel-burners' },
  { when: /gold|bullion|safe ?haven|flight to safety/i, commodity: 'Gold ↑', up: ['NEM', 'GOLD', 'FRES.L', 'AEM'], down: [], why: 'capital rotates into gold as a safe haven' },
  { when: /defen[cs]e|missile|weapon|nato|arms|military spend/i, commodity: 'Defence budgets ↑', up: ['LMT', 'RTX', 'NOC', 'BA.L', 'RHM.DE', 'GD'], down: [], why: 'conflict pulls forward defence procurement' },
  { when: /wheat|grain|ukraine|black sea|fertiliz|food/i, commodity: 'Grain/agri ↑', up: ['ADM', 'NTR', 'MOS', 'BG'], down: [], why: 'export disruption tightens food supply' },
  { when: /red sea|suez|shipping|freight|tanker|hormuz|container/i, commodity: 'Freight rates ↑', up: ['MAERSK-B.CO', 'ZIM', 'FDX'], down: ['IAG.L', 'DAL'], why: 're-routed shipping lifts freight, raises input costs' },
];

function start(bus) {
  bus.newsRadar = {
    headlines: [], byRegion: {}, byEntity: {}, bySource: {},
    global: 0, trumpFeed: [], cryptoFeed: [], warBoard: null, warNarrative: null,
    sources: 0, channels: FEEDS.length, total: 0, perTick: 0, cycles: 0, updated: null,
  };
  const seen = new Map();          // title -> firstSeen ms (TTL dedupe)
  const liveSources = new Map();   // source -> last time it produced a headline
  let idx = 0, tick = 0;

  async function batch() {
    if (bus.beat) bus.beat('newsradar');
    tick++;
    const slice = [];
    for (let i = 0; i < BATCH_SIZE; i++) { slice.push(FEEDS[idx % FEEDS.length]); idx++; }
    const at = Date.now();
    const results = await Promise.allSettled(slice.map(([url, source]) => fetchHeadlines(url, source, 12)));
    const fresh = [];
    results.forEach((res, i) => {
      const [, source, region] = slice[i];
      if (res.status !== 'fulfilled' || !res.value.length) return;
      for (const it of res.value) {
        const key = it.title.slice(0, 80).toLowerCase();
        if (seen.has(key)) continue;
        const entities = [];
        for (const [name, re] of Object.entries(ENTITIES)) if (re.test(it.title)) entities.push(name);
        if (!marketRelevant(it.title, entities)) continue;   // drop non-market fluff at the door
        seen.set(key, at);
        liveSources.set(source, at);                          // count a source live only when it yields RELEVANT news
        const score = scoreHeadline(it.title, source);
        fresh.push({ title: it.title, url: it.url || '', source, region, score, entities, at });
      }
    });

    // prune TTL from dedupe + live-source maps so counts reflect NOW
    for (const [k, t] of seen) if (at - t > TTL) seen.delete(k);
    for (const [s, t] of liveSources) if (at - t > TTL) liveSources.delete(s);
    // hard cap the dedupe map (Map keeps insertion order → drop the oldest) so heavy
    // flow across 690 channels can never blow the heap on a small Railway dyno.
    if (seen.size > 25000) { const drop = seen.size - 25000; let i = 0; for (const k of seen.keys()) { if (i++ >= drop) break; seen.delete(k); } }

    if (fresh.length) {
      const all = [...fresh, ...bus.newsRadar.headlines].filter(h => at - h.at < TTL).slice(0, WINDOW);
      bus.newsRadar.headlines = all;
      bus.newsRadar.total = all.length;
      recompute(all);
    }
    bus.newsRadar.perTick = fresh.length;
    bus.newsRadar.sources = liveSources.size;
    bus.newsRadar.updated = new Date().toLocaleTimeString();
    if (idx % FEEDS.length < BATCH_SIZE) {   // completed a full rotation
      bus.newsRadar.cycles++;
      if (bus.newsRadar.cycles <= 2 || bus.newsRadar.cycles % 20 === 0)
        console.log(`[newsradar] cycle #${bus.newsRadar.cycles}: ${liveSources.size}/${FEEDS.length} channels live, ${all_len()} stories in window`);
    }
  }
  const all_len = () => bus.newsRadar.headlines.length;

  function recompute(all) {
    // macro mood: strong-conviction weighted
    const strong = all.filter(h => Math.abs(h.score) > 0.3);
    bus.newsRadar.global = +((strong.length ? strong : all).reduce((a, h) => a + h.score, 0) / (strong.length || all.length || 1)).toFixed(2);

    const agg = (keyFn) => {
      const m = {};
      for (const h of all) for (const k of [].concat(keyFn(h))) (m[k] = m[k] || []).push(h.score);
      const out = {};
      for (const [k, arr] of Object.entries(m)) out[k] = { n: arr.length, score: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) };
      return out;
    };
    bus.newsRadar.byRegion = agg(h => h.region);
    bus.newsRadar.byEntity = agg(h => h.entities.length ? h.entities : []);
    bus.newsRadar.bySource = agg(h => h.source);

    // CATEGORY BUCKETS — a clean, human view: each theme with its mood, count + top stories.
    // This is what the dashboard shows instead of a raw firehose, so the radar reads clearly.
    const CATS = [
      ['Markets & economy', h => /market|stock|share|econom|gdp|earnings|nasdaq|ftse|dow|s&p|index/i.test(h.title)],
      ['Fed & rates', h => h.entities.includes('fed') || h.entities.includes('ecb') || h.entities.includes('boe') || /inflation|cpi|rate|yield/i.test(h.title)],
      ['War & geopolitics', h => h.entities.includes('war') || h.entities.includes('defense')],
      ['Oil & commodities', h => h.entities.includes('opec') || h.entities.includes('gold') || /oil|crude|copper|gas|metal|wheat/i.test(h.title)],
      ['Crypto', h => h.entities.includes('crypto') || h.region === 'CRYPTO'],
      ['Tariffs & trade', h => h.entities.includes('tariff')],
      ['China & Asia', h => h.entities.includes('china') || ['CHINA', 'JAPAN', 'KOREA', 'SEA', 'INDIA'].includes(h.region)],
      ['AI & tech', h => h.entities.includes('ai')],
      ['Earnings & M&A', h => h.entities.includes('earnings') || h.entities.includes('mna')],
      ['Trump & policy', h => h.entities.includes('trump')],
    ];
    bus.newsRadar.categories = CATS.map(([name, fn]) => {
      const hs = all.filter(fn);
      return { name, n: hs.length, score: hs.length ? +(hs.reduce((a, h) => a + h.score, 0) / hs.length).toFixed(2) : 0, top: hs.slice(0, 8).map(h => ({ title: h.title, url: h.url, source: h.source, score: h.score, region: h.region, at: h.at })) };
    }).filter(c => c.n > 0).sort((a, b) => b.n - a.n);

    // dedicated lanes
    bus.newsRadar.trumpFeed = all.filter(h => h.entities.includes('trump') || h.source === 'TruthSocial' || h.source === 'TrumpDesk' || h.source === 'WhiteHouse').slice(0, 40);
    // CRYPTO news mapped per coin — so the Crypto tab shows which coins the world is talking about
    const cryptoHeads = all.filter(h => h.entities.includes('crypto') || h.region === 'CRYPTO');
    bus.newsRadar.cryptoFeed = cryptoHeads.slice(0, 40);
    const COIN_RE = { BTC: /bitcoin|\bbtc\b/i, ETH: /ethereum|\beth\b/i, SOL: /\bsolana\b|\bsol\b/i, XRP: /\bxrp\b|ripple/i, DOGE: /dogecoin|\bdoge\b/i, BNB: /\bbnb\b|binance coin/i, ADA: /cardano|\bada\b/i };
    const coinAgg = {};
    for (const h of cryptoHeads) for (const [c, re] of Object.entries(COIN_RE)) if (re.test(h.title)) (coinAgg[c] = coinAgg[c] || []).push(h);
    bus.newsRadar.cryptoByCoin = Object.entries(coinAgg).map(([coin, hs]) => ({ coin, n: hs.length, score: +(hs.reduce((a, h) => a + h.score, 0) / hs.length).toFixed(2), top: hs.slice(0, 3).map(h => ({ title: h.title, url: h.url, source: h.source, score: h.score })) })).sort((a, b) => b.n - a.n);

    // COMMODITY news mapped per commodity — so each desk gets its own live sentiment
    const commodHeads = all.filter(h => h.entities.includes('commodity') || h.region === 'COMMODITY' || h.entities.includes('opec') || h.entities.includes('gold'));
    bus.newsRadar.commodFeed = commodHeads.slice(0, 40).map(h => ({ title: h.title, url: h.url, source: h.source, score: h.score, at: h.at }));
    const COMMOD_RE = {
      oil: /\boil\b|crude|\bwti\b|brent|\bopec\b|petroleum|barrel/i, natgas: /natural gas|\bLNG\b|\bnat-?gas\b/i,
      gold: /\bgold\b|bullion/i, silver: /\bsilver\b/i, platinum: /platinum|palladium/i,
      copper: /\bcopper\b/i, aluminium: /alumini?um/i, nickel: /\bnickel\b|\bzinc\b|\btin\b/i, ironore: /iron ore/i,
      wheat: /\bwheat\b/i, corn: /\bcorn\b/i, soybeans: /soybean/i,
      coffee: /\bcoffee\b/i, cocoa: /\bcocoa\b/i, sugar: /\bsugar\b/i, cotton: /\bcotton\b/i,
      lithium: /lithium|battery metal/i, uranium: /uranium|nuclear fuel/i, rareearth: /rare earth|cobalt/i,
    };
    const cAgg = {};
    for (const h of commodHeads) for (const [c, re] of Object.entries(COMMOD_RE)) if (re.test(h.title)) (cAgg[c] = cAgg[c] || []).push(h);
    bus.newsRadar.commodByType = Object.entries(cAgg).map(([commodity, hs]) => ({ commodity, n: hs.length, score: +(hs.reduce((a, h) => a + h.score, 0) / hs.length).toFixed(2), top: hs.slice(0, 3).map(h => ({ title: h.title, url: h.url, source: h.source, score: h.score })) })).sort((a, b) => b.n - a.n);
    bus.newsRadar.trumpAssets = {
      assets: TRUMP_ASSETS, syms: TRUMP_ASSETS.map(a => a.sym),
      headlines: all.filter(h => h.source === 'TrumpDesk' || /trump media|\bDJT\b|world liberty|\$TRUMP|trump organization|trump family/i.test(h.title)).slice(0, 20),
    };

    // WAR → COMMODITY analysis
    const warHeads = all.filter(h => h.entities.includes('war') || h.entities.includes('opec') || h.entities.includes('defense')).slice(0, 60);
    if (warHeads.length >= 2) {
      const text = warHeads.map(h => h.title).join(' · ');
      const chains = WAR_CHAINS.filter(c => c.when.test(text)).map(c => ({ commodity: c.commodity, up: c.up, down: c.down, why: c.why }));
      const intensity = +(warHeads.reduce((a, h) => a + Math.min(0, h.score), 0) / warHeads.length).toFixed(2);
      bus.newsRadar.warBoard = { active: chains.length > 0, intensity, chains, headlines: warHeads.slice(0, 8).map(h => ({ title: h.title, source: h.source, at: h.at })) };
      bus.newsRadar.warNarrative = chains.length
        ? `⚔️ Geopolitical risk live (intensity ${intensity}). Chain of consequence: ${chains.map(c => c.commodity).join(', ')}. The desk is watching ${[...new Set(chains.flatMap(c => c.up))].slice(0, 8).join(', ')} to the upside.`
        : `Geopolitical headlines present but no clear commodity chain yet (intensity ${intensity}).`;
    } else {
      bus.newsRadar.warBoard = { active: false, intensity: 0, chains: [], headlines: [] };
      bus.newsRadar.warNarrative = 'No active war/geopolitical commodity chain right now — calm tape.';
    }
  }

  batch(); setInterval(batch, BATCH_MS);
  console.log(`[newsradar] armed — ${FEEDS.length} live channels across 15 regions, rotating ${BATCH_SIZE}/batch every ${BATCH_MS / 1000}s (Trump + crypto + war→commodity lanes)`);
}
module.exports = { start };
