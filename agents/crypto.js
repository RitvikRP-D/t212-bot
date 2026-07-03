'use strict';
// AGENT ⑩: CRYPTO SCANNER — 24/7, never sleeps. Binance public spot data
// (1-min klines, free, no key) for the top coins + crypto-specific news flow
// (CoinDesk/CoinTelegraph/Google), and maps each coin to the Trading212 crypto
// ETPs/ETNs that actually trade on the account, so conviction found at 3am
// becomes a queued order that fires the second the LSE/Xetra bell rings.
const { CRYPTO_MS } = require('../config');
const { calcRSI, calcMACD, extendedMetrics, evaluate } = require('../lib/indicators');

const COINS = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','LINK','LTC','UNI','ATOM','XLM','ETC','FIL','APT','ARB','OP','NEAR','INJ','SUI','TIA','SEI','FET','RNDR','TON','TRX','SHIB','PEPE'];
// coin -> regexes matched against T212 instrument names to find its tradable ETP
const ETP_RE = {
  BTC: /bitcoin/i, ETH: /ethereum/i, SOL: /\bsolana\b/i, XRP: /\bxrp|ripple\b/i,
  ADA: /\bcardano\b/i, DOT: /\bpolkadot\b/i, LINK: /\bchainlink\b/i, LTC: /\blitecoin\b/i,
  AVAX: /\bavalanche\b/i, DOGE: /\bdogecoin\b/i, ATOM: /\bcosmos\b/i, UNI: /\buniswap\b/i,
  NEAR: /\bnear protocol\b/i, TON: /\btoncoin\b/i, TRX: /\btron\b/i, XLM: /\bstellar\b/i,
};
const POS_RE = /(etf approv|inflow|adoption|halving|institutional|accumulat|rally|surge|all-time high|bullish|upgrade|integrat|partnership|legal (win|victory)|spot etf)/gi;
const NEG_RE = /(hack|exploit|ban|crackdown|lawsuit|sec sue|fraud|outflow|selloff|liquidat|crash|plunge|bankrupt|delist|scam|rug)/gi;
// BOOTSTRAP: T212 API rate-limits instrument fetches; meanwhile, start trading with these known ETPs
const BOOTSTRAP_ETPs = {
  ETH: 'ETHP.L', BTC: 'BTCP.L', AVAX: 'MLAC1.L', SOL: null, BNB: null, XRP: null,
};

function start(bus) {
  bus.crypto = {};       // COIN -> {price, rsi, conf, why, ...}
  bus.cryptoNews = { headlines: [], global: 0, perCoin: {}, updated: null };
  bus.cryptoStatus = { scanned: 0, errors: 0, coins: COINS.length, etpsMapped: 0, lastSym: null, topConf: null };
  let idx = 0;

  // find each coin's tradable T212 ETP; bootstrap with known ETPs, then expand from universe
  function mapETPs() {
    let mapped = 0;
    for (const [coin, etp] of Object.entries(BOOTSTRAP_ETPs)) {
      if (etp) { (bus.crypto[coin] = bus.crypto[coin] || {}).etp = etp; mapped++; }
    }
    // also try the full-name regex match if the universe expanded
    for (const [coin, re] of Object.entries(ETP_RE)) {
      if (bus.crypto[coin]?.etp) continue; // already have a bootstrap one
      const hit = bus.universe && bus.universe.length > 1000 && bus.universe.find(u => u.t212 && re.test(u.name) && !/short|-1x|3x|2x|inverse/i.test(u.name));
      if (hit) { (bus.crypto[coin] = bus.crypto[coin] || {}).etp = hit.y; mapped++; }
    }
    bus.cryptoStatus.etpsMapped = mapped;
  }
  mapETPs(); setInterval(mapETPs, 120000);

  async function scanCoin(coin) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1m&limit=120`);
      if (!r.ok) { bus.cryptoStatus.errors++; return; }
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length < 30) return;
      const opens = rows.map(k => +k[1]), highs = rows.map(k => +k[2]), lows = rows.map(k => +k[3]),
            closes = rows.map(k => +k[4]), vols = rows.map(k => +k[5]);
      const c = bus.crypto[coin] = bus.crypto[coin] || {};
      c.closes = closes;
      Object.assign(c, extendedMetrics(opens, highs, lows, closes, vols));
      c.price = closes[closes.length - 1];
      c.pct24h = (c.price - closes[0]) / closes[0] * 100;
      c.rsi = calcRSI(closes);
      const m = calcMACD(closes);
      if (m) { c.crossUp = m.crossUp; c.crossDown = m.crossDown; }
      const senti = (bus.cryptoNews.perCoin[coin] || 0) + bus.cryptoNews.global * 0.3;
      const ev = evaluate(c, senti, bus.news?.fng?.value ?? null, 1);
      // TradingView crypto analyst boost (agent ⑪)
      let conf = ev ? ev.conf : 0, why = ev ? ev.reasons.join(' · ') : 'no setup';
      const tvc = bus.tvCrypto && bus.tvCrypto[coin];
      if (tvc && ev) { conf = Math.max(0, Math.min(1, conf + tvc.rec * 0.18)); why += ` · TV-crypto ${tvc.label} (${tvc.rec.toFixed(2)})`; }
      c.conf = +conf.toFixed(2); c.why = why; c.sigType = ev ? ev.sigType : null;
      c.lastTick = new Date().toLocaleTimeString();
      bus.cryptoStatus.scanned++;
      bus.cryptoStatus.lastSym = coin;
      const top = Object.entries(bus.crypto).filter(([, v]) => v.conf).sort((a, b) => b[1].conf - a[1].conf)[0];
      if (top) bus.cryptoStatus.topConf = `${top[0]} ${(top[1].conf * 100).toFixed(0)}%`;
      // hand conviction to the allocator: it queues the mapped ETP for next open
      if (c.etp && c.conf >= 0.5 && bus.queueSignal) {
        bus.queueSignal(c.etp, c.conf, `crypto:${coin} ${why}`, 'crypto');
      }
    } catch (e) { bus.cryptoStatus.errors++; }
  }

  async function refreshNews() {
    const heads = [];
    const feeds = [
      ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'],
      ['https://cointelegraph.com/rss', 'CoinTelegraph'],
      ['https://news.google.com/rss/search?q=bitcoin+OR+ethereum+OR+crypto+regulation+when:1d&hl=en-GB', 'GoogleNews'],
      ['https://news.google.com/rss/search?q=blockchain+OR+"crypto+market"+when:1d&hl=en-US', 'GoogleNews'],
    ];
    for (const [u, s] of feeds) {
      try {
        const xml = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (research)' } })).text();
        const re = /<title>(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?<\/title>/g;
        let m, first = true;
        while ((m = re.exec(xml)) && heads.length < 60) {
          if (first) { first = false; continue; }
          heads.push({ title: m[1].trim(), source: s });
        }
      } catch (e) {}
    }
    if (!heads.length) return;
    for (const h of heads) h.score = Math.max(-3, Math.min(3, (h.title.match(POS_RE) || []).length - (h.title.match(NEG_RE) || []).length));
    bus.cryptoNews.headlines = heads.slice(0, 30);
    bus.cryptoNews.global = +(heads.reduce((a, h) => a + h.score, 0) / heads.length).toFixed(2);
    const per = {};
    const NAMES2 = { BTC: /bitcoin|btc/i, ETH: /ethereum|eth\b/i, SOL: /solana/i, XRP: /xrp|ripple/i, ADA: /cardano/i, DOGE: /dogecoin/i, DOT: /polkadot/i, LINK: /chainlink/i, AVAX: /avalanche/i };
    for (const [coin, re] of Object.entries(NAMES2)) {
      const rel = heads.filter(h => re.test(h.title));
      if (rel.length) per[coin] = +(rel.reduce((a, h) => a + h.score, 0) / rel.length).toFixed(2);
    }
    bus.cryptoNews.perCoin = per;
    bus.cryptoNews.updated = new Date().toLocaleTimeString();
  }

  setInterval(() => scanCoin(COINS[idx++ % COINS.length]), CRYPTO_MS);
  refreshNews(); setInterval(refreshNews, 120000);
  console.log(`[crypto] 24/7 scanner started — ${COINS.length} coins on Binance 1m + crypto news + T212 ETP mapping`);
}
module.exports = { start };
