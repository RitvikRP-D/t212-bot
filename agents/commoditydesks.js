'use strict';
// EIGHT COMMODITY DESKS — thematic analysis over the commodity complex, mirroring the ten
// equity desks. Each desk groups its commodities, reads live futures technicals (bus.commod,
// fed ~23h/day by agents/commodities.js), overlays its OWN dedicated news sentiment
// (bus.newsRadar.commodByType) and the market regime, forms a house view + a best pick, and
// folds a BOUNDED advisory signal into the trader on the mapped T212 ETC. Never a blind follow.
//   ① Energy  ② Precious Metals  ③ Agriculture  ④ Softs
//   ⑤ Industrial Metals  ⑥ Rare Earths & Battery  ⑦ Commodity Index  ⑧ Volatility & Hedge
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const r2 = v => v == null ? null : +(+v).toFixed(2);

// members = commodity keys in bus.commod; news = commodByType keys that inform the desk.
const DESKS = [
  { key: 'energy',     name: 'Energy Desk',                emoji: '🛢️', members: ['wti-oil', 'brent-oil', 'natgas'],           news: ['oil', 'natgas'],                driver: 'OPEC+ supply, US shale/rig count, inventories, the dollar' },
  { key: 'precious',   name: 'Precious Metals',            emoji: '🥇', members: ['gold', 'silver', 'platinum', 'palladium'],  news: ['gold', 'silver', 'platinum'],   driver: 'real yields, the dollar, safe-haven flows, central-bank buying' },
  { key: 'agri',       name: 'Agriculture',                emoji: '🌾', members: ['wheat', 'corn', 'soybeans'],                 news: ['wheat', 'corn', 'soybeans'],    driver: 'weather, USDA/WASDE crop reports, Black-Sea export flows' },
  { key: 'softs',      name: 'Softs',                      emoji: '☕', members: ['coffee', 'sugar', 'cocoa', 'cotton'],       news: ['coffee', 'cocoa', 'sugar', 'cotton'], driver: 'climate shocks, harvest disruption, demand swings' },
  { key: 'industrial', name: 'Industrial Metals',          emoji: '🏗️', members: ['copper', 'aluminium', 'nickel', 'zinc'],     news: ['copper', 'aluminium', 'nickel', 'ironore'], driver: 'China demand, manufacturing PMI, construction, LME inventories' },
  { key: 'battery',    name: 'Rare Earths & Battery',      emoji: '🔋', members: ['lithium', 'uranium', 'carbon'],             news: ['lithium', 'uranium', 'rareearth'], driver: 'EV/battery demand, nuclear buildout, concentrated supply' },
  { key: 'index',      name: 'Commodity Index',            emoji: '📈', members: ['broad', 'agri', 'gold', 'copper', 'wti-oil'], news: [],                             driver: 'the whole complex as one asset class — broad regime' },
  { key: 'vol',        name: 'Volatility & Hedge',         emoji: '🛡️', members: ['gold', 'wti-oil'],                          news: ['gold', 'oil'],                  driver: 'commodities-vs-equities correlation, tail-risk hedge' },
];

function start(bus) {
  bus.commodDesks = {};
  bus.commodDeskSignal = {};
  const TICK_MS = 45000;

  // resolve a commodity ETC ticker to the actual T212 universe symbol so the signal can reach the trader
  function resolve(sym) {
    if (!sym) return sym;
    if (bus.market && bus.market[sym]) return sym;
    const uni = bus.universe || [];
    const hit = uni.find(u => u.y === sym || u.y.split(/[._]/)[0] === sym);
    return hit ? hit.y : sym;
  }

  // news sentiment for a desk = mean score across its mapped commodByType buckets
  function deskNews(keys) {
    const bt = (bus.newsRadar && bus.newsRadar.commodByType) || [];
    const hit = bt.filter(x => keys.includes(x.commodity));
    if (!hit.length) return { score: 0, n: 0, top: null };
    const n = hit.reduce((a, x) => a + x.n, 0);
    const score = +(hit.reduce((a, x) => a + x.score * x.n, 0) / (n || 1)).toFixed(2);
    const top = hit.flatMap(x => x.top || []).sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0] || null;
    return { score, n, top };
  }

  function tick() {
    if (bus.beat) bus.beat('commoditydesks');
    const commod = bus.commod || {};
    const regime = (bus.regime && (bus.regime.state || bus.regime.regime)) || null;   // e.g. risk-on / risk-off / chop
    const riskOff = /off|shock|bear|stress|fear/i.test(String(regime || ''));
    const sig = {};
    const addSig = (etp, v, why) => { const s = resolve(etp); if (!s) return; sig[s] = { score: +clamp((sig[s]?.score || 0) + v).toFixed(3), why }; };

    for (const d of DESKS) {
      // gather live constituents
      const members = d.members.map(k => {
        const c = commod[k]; if (!c || c.price == null) return null;
        const trend = c.crossUp ? 1 : c.crossDown ? -1 : 0;
        const rsi = c.rsi != null ? c.rsi : null;
        // combined per-commodity read: its own conf (news+futures from commodities.js) + trend + RSI extremes
        let combined = (c.conf || 0);
        if (trend) combined += trend * 0.15;
        if (rsi != null) { if (rsi < 30) combined += 0.1; else if (rsi > 70) combined -= 0.1; }
        return { key: k, price: r2(c.price), pct24h: r2(c.pct24h), rsi: r2(rsi), conf: r2(c.conf || 0), trend, etp: c.etp || null, etpName: c.etpName || null, combined: +clamp(combined).toFixed(3), why: c.why || '' };
      }).filter(Boolean);

      const news = deskNews(d.news);
      // regime overlay: precious/hedge lean up in risk-off, industrial/energy lean down
      let regimeTilt = 0;
      if (riskOff && (d.key === 'precious' || d.key === 'vol')) regimeTilt = 0.12;
      if (riskOff && (d.key === 'industrial' || d.key === 'energy')) regimeTilt = -0.1;

      const memAvg = members.length ? members.reduce((a, m) => a + m.combined, 0) / members.length : 0;
      const houseScore = +clamp(memAvg * 0.7 + news.score * 0.25 + regimeTilt).toFixed(2);
      const stance = houseScore > 0.25 ? 'BULLISH' : houseScore < -0.25 ? 'BEARISH' : 'NEUTRAL';

      // best pick = strongest constituent that is actually tradeable (has an ETC)
      const tradeable = members.filter(m => m.etp).sort((a, b) => b.combined - a.combined);
      const pick = tradeable[0] || null;

      // narrative
      const lead = members.slice().sort((a, b) => b.combined - a.combined)[0];
      const parts = [`${d.name}: ${stance} (${houseScore >= 0 ? '+' : ''}${houseScore}).`];
      if (lead) parts.push(`Strongest: ${lead.key} ${lead.pct24h != null ? (lead.pct24h >= 0 ? '+' : '') + lead.pct24h + '% 24h' : ''}${lead.trend > 0 ? ' (MACD up)' : lead.trend < 0 ? ' (MACD down)' : ''}.`);
      if (news.n) parts.push(`News ${news.score >= 0 ? '+' : ''}${news.score} across ${news.n} stories${news.top ? `: "${String(news.top.title).slice(0, 60)}"` : ''}.`);
      if (regimeTilt) parts.push(`Regime ${riskOff ? 'risk-off' : 'risk-on'} tilt ${regimeTilt >= 0 ? '+' : ''}${regimeTilt}.`);
      if (pick) parts.push(`Best expression: ${pick.key} via ${pick.etpName || pick.etp}.`);
      parts.push(`Drivers: ${d.driver}. Advisory only — one vote among the fleet.`);

      bus.commodDesks[d.key] = {
        name: d.name, emoji: d.emoji, stance, houseScore, driver: d.driver,
        members, news, regime: riskOff ? 'risk-off' : (regime || 'neutral'), regimeTilt,
        pick: pick ? { key: pick.key, etp: pick.etp, etpName: pick.etpName, combined: pick.combined } : null,
        narrative: parts.join(' '), updated: new Date().toLocaleTimeString(),
      };

      // fold BOUNDED signals into the trader on tradeable ETCs whose desk view is strong
      for (const m of tradeable) {
        const s = +clamp(m.combined * 0.6 + houseScore * 0.4).toFixed(3);
        if (Math.abs(s) >= 0.35) addSig(m.etp, clamp(s * 0.5, -0.12, 0.12), `${d.name} ${stance}: ${m.key} ${m.why}`.slice(0, 160));
      }
    }

    bus.commodDeskSignal = sig;
    // headline board summary
    bus.commodDesksSummary = DESKS.map(d => {
      const x = bus.commodDesks[d.key]; return x ? { key: d.key, name: d.name, emoji: d.emoji, stance: x.stance, score: x.houseScore, pick: x.pick && x.pick.key } : null;
    }).filter(Boolean);
  }

  setInterval(tick, TICK_MS);
  setTimeout(tick, 16000);
  console.log(`[commoditydesks] 8 commodity desks armed — energy/precious/agri/softs/industrial/battery/index/vol → advisory signals`);
}
module.exports = { start };
