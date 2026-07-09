'use strict';
// AGENT ⑫: COMMODITIES — gold, silver, platinum, palladium, copper, oil, gas,
// wheat, corn, coffee, sugar, cocoa, cotton, soybeans, cattle, aluminium, uranium,
// lithium, nickel/zinc/agri baskets… 24 targets. Futures trade ~23h Sun–Fri on
// Globex, so this agent reads live futures (Yahoo, free) nearly around the clock,
// finds conviction, and maps each commodity to a real Trading212 ETC/ETF to buy
// the moment London/Xetra opens. Signals hand off to the allocator's queue.
const { COMMOD_MS } = require('../config');
const { calcRSI, calcMACD, extendedMetrics, evaluate } = require('../lib/indicators');

const TARGETS = [
  { key: 'gold',      fut: 'GC=F',  re: /physical gold|gold etc|gold bullion|invesco physical gold|ishares physical gold|wisdomtree.*gold(?!.*miner)/i },
  { key: 'silver',    fut: 'SI=F',  re: /physical silver|silver etc|wisdomtree.*silver|ishares.*silver/i },
  { key: 'platinum',  fut: 'PL=F',  re: /platinum/i },
  { key: 'palladium', fut: 'PA=F',  re: /palladium/i },
  { key: 'copper',    fut: 'HG=F',  re: /\bcopper\b/i },
  { key: 'wti-oil',   fut: 'CL=F',  re: /wti|crude oil(?!.*short)/i },
  { key: 'brent-oil', fut: 'BZ=F',  re: /brent/i },
  { key: 'natgas',    fut: 'NG=F',  re: /natural gas(?!.*short)/i },
  { key: 'wheat',     fut: 'ZW=F',  re: /\bwheat\b/i },
  { key: 'corn',      fut: 'ZC=F',  re: /\bcorn\b/i },
  { key: 'soybeans',  fut: 'ZS=F',  re: /soybean/i },
  { key: 'coffee',    fut: 'KC=F',  re: /\bcoffee\b/i },
  { key: 'sugar',     fut: 'SB=F',  re: /\bsugar\b/i },
  { key: 'cocoa',     fut: 'CC=F',  re: /\bcocoa\b/i },
  { key: 'cotton',    fut: 'CT=F',  re: /\bcotton\b/i },
  { key: 'cattle',    fut: 'LE=F',  re: /livestock|cattle/i },
  { key: 'aluminium', fut: 'ALI=F', re: /aluminium|aluminum/i },
  { key: 'nickel',    fut: null,    re: /\bnickel\b/i },
  { key: 'zinc',      fut: null,    re: /\bzinc\b/i },
  { key: 'uranium',   fut: null,    re: /uranium/i },
  { key: 'lithium',   fut: null,    re: /lithium|battery metal/i },
  { key: 'carbon',    fut: null,    re: /\bcarbon\b/i },
  { key: 'agri',      fut: null,    re: /agriculture etc|agriculture etf|agri commodit/i },
  { key: 'broad',     fut: null,    re: /all commodities|broad commodit|bloomberg commodity/i },
];

// BOOTSTRAP: T212 API rate-limits instrument fetches; start with these known ETCs
const BOOTSTRAP_ETCs = {
  gold: { etp: 'RMAU.L', name: 'Royal Mint Responsibly Sourced Physical Gold' },
  silver: { etp: 'PHAG.L', name: 'WisdomTree Physical Silver' },
  platinum: { etp: 'SPPT.L', name: 'WisdomTree Physical Platinum' },
  palladium: { etp: 'PHPD.L', name: 'WisdomTree Physical Palladium' },
  copper: { etp: 'COPA.L', name: 'WisdomTree Copper' },
  'wti-oil': { etp: 'CRUD.L', name: 'WisdomTree WTI Crude Oil' },
  'brent-oil': { etp: 'BRNT.L', name: 'WisdomTree Brent Crude Oil' },
  'natgas': { etp: 'NGAS.L', name: 'WisdomTree Natural Gas' },
  wheat: { etp: 'WEAT.L', name: 'Wisdomtree Wheat' },
  corn: { etp: 'CORN.MI', name: 'WisdomTree Corn' },
  soybeans: { etp: 'ESOY.MI', name: 'WisdomTree Soybeans - EUR Daily Hedged' },
  coffee: { etp: 'COFF.L', name: 'WisdomTree Coffee' },
  sugar: { etp: 'SUGA.L', name: 'WisdomTree Sugar' },
  cocoa: { etp: 'COCO.L', name: 'WisdomTree Cocoa' },
  cotton: { etp: 'COTN.L', name: 'WisdomTree Cotton' },
  cattle: null,
  aluminium: { etp: 'ALUM.L', name: 'WisdomTree Aluminium' },
  nickel: { etp: 'NICK.L', name: 'WisdomTree Nickel' },
  zinc: { etp: 'ZINC.L', name: 'WisdomTree Zinc' },
  uranium: { etp: 'URNM.L', name: 'Sprott Uranium Miners ETF' },
  lithium: { etp: 'LITG.L', name: 'Global X Lithium & Battery Tech' },
  carbon: { etp: 'CARB.L', name: 'WisdomTree Carbon' },
  agri: { etp: 'AGAP.L', name: 'WisdomTree Agriculture' },
  broad: { etp: 'AIGC.L', name: 'WisdomTree Broad Commodities' },
};

function start(bus) {
  bus.commod = {};   // key -> {price, rsi, conf, why, etp}
  bus.commodStatus = { scanned: 0, errors: 0, targets: TARGETS.length, mapped: 0, lastSym: null, topConf: null };
  let idx = 0;

  // only real ETC/ETP issuers — a company with "Coffee" in its name is NOT the commodity
  const ISSUER_RE = /wisdomtree|ishares|invesco|xtrackers|amundi|vaneck|hanetf|global x|l&g|etfs |\betc\b|\betp\b|physical/i;
  function mapETCs() {
    let mapped = 0;
    // BOOTSTRAP: use known ETCs first
    for (const [key, info] of Object.entries(BOOTSTRAP_ETCs)) {
      if (info && info.etp) { (bus.commod[key] = bus.commod[key] || {}).etp = info.etp; (bus.commod[key]).etpName = info.name; mapped++; }
    }
    // then try regex matching if universe expanded
    for (const t of TARGETS) {
      if (bus.commod[t.key]?.etp) continue; // already bootstrapped
      const hit = bus.universe && bus.universe.length > 1000 && bus.universe.find(u => u.t212 && t.re.test(u.name) && ISSUER_RE.test(u.name) && !/short|-1x|3x|2x|inverse|leveraged/i.test(u.name));
      if (hit) { (bus.commod[t.key] = bus.commod[t.key] || {}).etp = hit.y; (bus.commod[t.key]).etpName = hit.name; mapped++; }
    }
    bus.commodStatus.mapped = mapped;
  }
  mapETCs(); setInterval(mapETCs, 120000);

  // fetch 1-min candles for a symbol from Yahoo; returns parsed arrays or null
  async function fetchChart(sym) {
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const r = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' } });
        if (!r.ok) continue;
        const j = await r.json();
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res || !res.indicators || !res.indicators.quote) continue;
        const q = res.indicators.quote[0];
        const opens = [], highs = [], lows = [], closes = [], vols = [];
        for (let i = 0; i < (q.close || []).length; i++) {
          if (q.close[i] == null) continue;
          closes.push(q.close[i]); opens.push(q.open?.[i] ?? q.close[i]);
          highs.push(q.high?.[i] ?? q.close[i]); lows.push(q.low?.[i] ?? q.close[i]); vols.push(q.volume?.[i] ?? 0);
        }
        if (closes.length < 30) continue;
        // LSE ETCs quote in GBX pence — normalize like the stock scanner does
        if (res.meta && res.meta.currency === 'GBp') {
          for (const a of [opens, highs, lows, closes]) for (let i = 0; i < a.length; i++) a[i] /= 100;
          if (res.meta.regularMarketPrice) res.meta.regularMarketPrice /= 100;
          if (res.meta.chartPreviousClose) res.meta.chartPreviousClose /= 100;
          if (res.meta.previousClose) res.meta.previousClose /= 100;
          res.meta.currency = 'GBP';
        }
        return { res, opens, highs, lows, closes, vols };
      } catch (e) { /* try next host */ }
    }
    return null;
  }

  async function scan(t) {
    const c = bus.commod[t.key] = bus.commod[t.key] || {};
    // Try the future first (23h/day signal). Yahoo increasingly blocks =F futures symbols,
    // so FALL BACK to the mapped ETC/ETF price (what we actually trade) — this keeps every
    // desk populated even when futures are unavailable.
    if (!t.fut && !c.etp) return;
    try {
      let data = t.fut ? await fetchChart(t.fut) : null;
      let priceSrc = data ? 'futures' : null;
      if (!data && c.etp) { data = await fetchChart(c.etp); priceSrc = data ? 'ETC' : null; }
      if (!data) { bus.commodStatus.errors++; return; }
      const { res, opens, highs, lows, closes, vols } = data;
      c.priceSrc = priceSrc;
      c.closes = closes.slice(-120);
      Object.assign(c, extendedMetrics(opens.slice(-120), highs.slice(-120), lows.slice(-120), closes.slice(-120), vols.slice(-120)));
      c.price = res.meta.regularMarketPrice || closes[closes.length - 1];
      const prev = res.meta.chartPreviousClose || res.meta.previousClose;
      c.pct24h = prev ? (c.price - prev) / prev * 100 : null;
      c.rsi = calcRSI(c.closes);
      const m = calcMACD(c.closes);
      if (m) { c.crossUp = m.crossUp; c.crossDown = m.crossDown; }
      // deep-news topic boost (livenews agent tracks gold/oil/rates chatter)
      // livenews keys oil chatter under 'oil' — 'wti-oil'/'brent-oil' must map there, not to 'wti'/'brent'
      const topicKey = t.key.endsWith('-oil') ? 'oil' : t.key.split('-')[0];
      const topic = bus.deepNews && bus.deepNews.perTopic && bus.deepNews.perTopic[topicKey];
      const ev = evaluate(c, topic || 0, bus.news?.fng?.value ?? null, 1);
      c.conf = ev ? +ev.conf.toFixed(2) : 0;
      c.why = ev ? `${t.key} (${c.priceSrc}): ` + ev.reasons.join(' · ') : 'no setup';
      c.lastTick = new Date().toLocaleTimeString();
      bus.commodStatus.scanned++;
      bus.commodStatus.lastSym = t.key;
      const top = Object.entries(bus.commod).filter(([, v]) => v.conf).sort((a, b) => b[1].conf - a[1].conf)[0];
      if (top) bus.commodStatus.topConf = `${top[0]} ${(top[1].conf * 100).toFixed(0)}%`;
      if (c.etp && c.conf >= 0.5 && bus.queueSignal) bus.queueSignal(c.etp, c.conf, `commodity:${c.why} → ${c.etpName}`, 'commodity');
    } catch (e) { bus.commodStatus.errors++; }
  }

  setInterval(() => scan(TARGETS[idx++ % TARGETS.length]), COMMOD_MS);
  console.log(`[commodities] agent started — ${TARGETS.length} commodities via ~23h futures + T212 ETC mapping`);
}
module.exports = { start };
