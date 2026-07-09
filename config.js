'use strict';
// T212 VIRTUAL TRADER — completely separate from the crypto bot project.
// Fallback universe used until T212 connects; once connected, the universe is built
// from Trading212's OWN instrument list (thousands of stocks/ETFs) automatically.
const US = ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK-B','JPM','V','UNH','XOM','WMT','JNJ','PG','MA','HD','COST','ORCL','CVX','ABBV','MRK','KO','PEP','BAC','AMD','CRM','NFLX','TMO','LLY','AVGO','ADBE','CSCO','ACN','MCD','ABT','DHR','LIN','TXN','NEE','PM','UPS','RTX','HON','QCOM','INTC','IBM','CAT','GE','AMGN','LOW','BA','SBUX','PFE','GS','BLK','ISRG','SPGI','DE','MDT','ADP','BKNG','MMC','PLD','T','VZ','SCHW','C','MS','AXP','NOW','UBER','PANW','SNOW','SHOP','PYPL','COIN','PLTR','ABNB','DIS','NKE','F','GM','RIVN','LCID','DAL','UAL','AAL','CCL','RCL','MAR','HLT','DKNG','ROKU','ZM','DOCU','CRWD','ZS','DDOG','NET','MDB','TEAM','OKTA','TWLO','SPOT','PINS','SNAP','ETSY','EBAY','BABA','JD','PDD','NIO','XPEV','LI','TSM','MU','AMAT','LRCX','KLAC','ADI','NXPI','ON','ARM','SMCI','DELL','HPQ','WDC','STX','ENPH','FSLR','RUN','PLUG','O','SPG','AMT','CCI','EQIX','PSA','DLR','WELL','AVB','EQR'];
const ETF = ['SPY','QQQ','IWM','DIA','VTI','VOO','IVV','VEA','VWO','EEM','EFA','AGG','BND','TLT','HYG','LQD','GLD','SLV','USO','UNG','XLE','XLF','XLK','XLV','XLI','XLP','XLY','XLU','XLB','XLRE','VGK','EWU','EWG','EWJ','FXI','ARKK','SOXX','SMH','JETS','XBI'];
const UK = ['HSBA.L','ULVR.L','AZN.L','SHEL.L','BP.L','GSK.L','RIO.L','GLEN.L','BATS.L','DGE.L','LLOY.L','BARC.L','NWG.L','STAN.L','VOD.L','BT-A.L','TSCO.L','SBRY.L','MKS.L','NG.L','SSE.L','LSEG.L','REL.L','PRU.L','AV.L','LGEN.L','RR.L','BA.L','IAG.L','EZJ.L','WTB.L','KGF.L','JD.L','OCDO.L'];
const EU = ['SAP.DE','SIE.DE','ALV.DE','BMW.DE','MBG.DE','VOW3.DE','BAS.DE','BAYN.DE','ADS.DE','DTE.DE','DBK.DE','AIR.PA','MC.PA','OR.PA','SAN.PA','BNP.PA','TTE.PA','CS.PA','SU.PA','ASML.AS','ADYEN.AS','INGA.AS','PHIA.AS','HEIA.AS','NESN.SW','NOVN.SW','ROG.SW'];

const NAMES = { AAPL:'Apple', MSFT:'Microsoft', GOOGL:'Google|Alphabet', AMZN:'Amazon', NVDA:'Nvidia', META:'Meta|Facebook', TSLA:'Tesla', JPM:'JPMorgan', XOM:'Exxon', WMT:'Walmart', JNJ:'Johnson & Johnson', BAC:'Bank of America', AMD:'AMD', NFLX:'Netflix', INTC:'Intel', BA:'Boeing', PFE:'Pfizer', DIS:'Disney', NKE:'Nike', F:'Ford', GM:'General Motors', BABA:'Alibaba', TSM:'TSMC|Taiwan Semi', 'HSBA.L':'HSBC', 'ULVR.L':'Unilever', 'AZN.L':'AstraZeneca', 'SHEL.L':'Shell', 'BP.L':'BP', 'GSK.L':'GSK', 'RIO.L':'Rio Tinto', 'BARC.L':'Barclays', 'VOD.L':'Vodafone', 'TSCO.L':'Tesco', 'SAP.DE':'SAP', 'BMW.DE':'BMW', 'VOW3.DE':'Volkswagen', 'ADS.DE':'Adidas', 'AIR.PA':'Airbus', 'MC.PA':'LVMH', 'TTE.PA':'TotalEnergies', 'ASML.AS':'ASML', 'NESN.SW':'Nestle', COIN:'Coinbase', PLTR:'Palantir', UBER:'Uber', SHOP:'Shopify', SPY:'S&P 500', QQQ:'Nasdaq' };

const HOURS = {
  US: { tz: 'America/New_York', open: [9,30], close: [16,0] },
  L:  { tz: 'Europe/London',    open: [8,0],  close: [16,30] },
  DE: { tz: 'Europe/Berlin',    open: [9,0],  close: [17,30] },
  PA: { tz: 'Europe/Paris',     open: [9,0],  close: [17,30] },
  AS: { tz: 'Europe/Amsterdam', open: [9,0],  close: [17,30] },
  SW: { tz: 'Europe/Zurich',    open: [9,0],  close: [17,30] },
  MI: { tz: 'Europe/Rome',      open: [9,0],  close: [17,30] },
  MC: { tz: 'Europe/Madrid',    open: [9,0],  close: [17,30] },
  TO: { tz: 'America/Toronto',  open: [9,30], close: [16,0] },
  VI: { tz: 'Europe/Vienna',    open: [9,0],  close: [17,30] },
  BR: { tz: 'Europe/Brussels',  open: [9,0],  close: [17,30] },
  LS: { tz: 'Europe/Lisbon',    open: [8,0],  close: [16,30] },
};
function venue(sym){ const p = sym.split('.'); return p.length > 1 ? p[1] : 'US'; }
function marketOpen(sym){
  const h = HOURS[venue(sym)]; if (!h) return false;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: h.tz, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false }).formatToParts(now);
  const get = t => parts.find(p => p.type === t).value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  // US holidays (hard-coded 2026 holidays)
  const v = venue(sym);
  if (v === 'US') {
    const month = now.getUTCMonth() + 1, day = now.getUTCDate();
    // 2026: Jan 1, Feb Presidents Day (16), May Memorial Day (25), Jul 3-4 (holiday observed Fri for Sat), Nov Thanksgiving (26), Dec 25
    const us_closed = [
      [1,1], [1,19], [2,16], [5,25], [7,3], [7,4], [11,26], [12,25]  // 2026 US holidays
    ];
    if (us_closed.some(([m, d]) => m === month && d === day)) return false;
  }
  const mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  return mins >= h.open[0]*60 + h.open[1] && mins < h.close[0]*60 + h.close[1];
}
// minutes until this symbol's venue closes (null if closed now) — used for overnight-hold logic
function minsToClose(sym){
  const h = HOURS[venue(sym)]; if (!h) return null;
  if (!marketOpen(sym)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: h.tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  return (h.close[0]*60 + h.close[1]) - mins;
}
function nextOpenInfo(){
  const opens = [];
  for (const [v, h] of Object.entries(HOURS)) opens.push(`${v} ${String(h.open[0]).padStart(2,'0')}:${String(h.open[1]).padStart(2,'0')} ${h.tz.split('/')[1]}`);
  return opens.join(' · ');
}

// ——— TRADING PROFILES ———
// A £10k practice account can afford aggression; a small REAL account cannot —
// FX conversion (~0.15% each way on non-GBP), spreads, and concentration will bleed
// £100 dry. The 'real' profile sizes small, diversifies, prefers fee-free GBP/LSE
// names, demands a higher edge, holds longer to avoid churn, and skips illiquid
// tickers. It applies to EVERY execution path — stocks, crypto ETPs and commodity
// ETCs all enter through the same trader gate.
const PROFILES = {
  practice: {
    // MAX-VARIANCE MODE (user-ordered, PRACTICE/demo money only — live is hard-locked to
    // the conservative profile): concentrated bets, no profit lock, deep loss tolerance.
    name: 'practice', perTradeCap: 0.90, sizeBase: 0.30, sizeSlope: 0.60,
    maxOpen: 999,               // slots bounded only by cash (T212 min order £1.50 is the real floor)
    quickTake: 0.01,            // momentum-trail arms at +1% net; runners ride until they turn
    minConf: 0.55, minHoldMin: 0, preferGBP: false,
    nonGbpPenalty: 0, minNotionalPerMin: 5000, stopLoss: 0.018, dailyMaxLoss: 0.15,   // 5k/min floor: no unfillable junk
    minNetProfit: 0, dailyProfitTarget: 0,     // 0 = never stop compounding a good day
    maxDrawdown: 0.50,          // hard halt only at −50% (real profile keeps the −10% floor)
    consensusMin: 1, sectorCap: 0.6, countryCap: 0.75, ladder: false,   // correlated aggression = one big bet paying many spreads
    recoveryTrigger: 0.06, overnightHold: true,   // #1 fix: enable overnight hold on practice too
    overnightMinProfit: 0.001,  // #2 fix: don't hold unless gain > 0.1% net (beats fees)
    volAdjustedSizing: true,    // size inverse to realized vol — a 3%-ATR biotech gets half a 1%-ATR mega-cap's size
    sentimentDecay: false,      // #new④: weight headlines by age
  },
  real: {
    name: 'real', perTradeCap: 0.25, sizeBase: 0.08, sizeSlope: 0.17,
    maxOpen: 6, minConf: 0.58, minHoldMin: 25, preferGBP: true,
    nonGbpPenalty: 0.015,  // honest FX friction (~0.3% round trip), not a 4-point wall — trade worldwide
    minNotionalPerMin: 3000, stopLoss: 0.03, dailyMaxLoss: 0.05,
    minNetProfit: 0.003,   // never take profit until gain clears fees + 0.3% NET (loosened from 0.8%)
    dailyProfitTarget: 0.03,   // up +3% on the day → bank it, no new entries till tomorrow
    consensusMin: 1,       // ≥1 independent agent vote required to open (loosened from 2)
    sectorCap: 0.5,        // ≤50% of open positions in one sector
    countryCap: 0.67,      // ≤2/3 of open positions in one country/venue
    ladder: true,          // scale out in thirds at +1R / +1.5R / target
    recoveryTrigger: 0.04, // >4% below baseline (but above the 10% hard floor) → recovery mode
    overnightHold: true,   // may hold a green, non-earnings position through the close
    overnightMinProfit: 0.005,  // #2 fix: require 0.5% net to hold overnight (real avoids thin profits)
    volAdjustedSizing: true,    // #new②: scale position size inverse to realized vol
    sentimentDecay: true,       // #new④: weight headlines by age
    earningsSmart: true,        // #new①: close positions before earnings report
  },
};
// A/B VARIANT — run a second demo instance with VARIANT=b to test a tweak against the
// baseline (both tag their trades so you can compare P&L). No effect unless set to 'b'.
const VARIANT = (process.env.VARIANT || 'a').toLowerCase();
if (VARIANT === 'b') { PROFILES.real.minConf += 0.02; PROFILES.real.dailyProfitTarget = 0.025; PROFILES.practice.minConf += 0.02; }

// T212 fee/friction model → round-trip cost as a fraction of the position.
// T212 Invest charges NO stock commission, but a 0.15% FX conversion EACH WAY on any
// instrument not in the account currency (GBP), PLUS the bid/ask spread you cross on
// the way in and out. Applied only under the 'real' profile — which also runs during
// real-profile validation on practice, so the P&L you judge is HONEST.
//   FX (round-trip): 0.15%×2 = 0.30% on non-GBP, 0 on GBP/.L
//   Spread (round-trip): estimated from liquidity — thin names cost far more to cross.
function fxPct(sym, profile) {
  if (!profile || profile.name !== 'real') return 0;
  return /\.L$/.test(String(sym)) ? 0 : 0.0030;
}
function spreadPct(mk, profile) {
  if (!profile || profile.name !== 'real' || !mk) return 0;
  const npm = mk.notionalPerMin || 0;     // traded value/min — liquidity proxy
  if (npm > 5e6) return 0.0004;            // mega-cap: razor spread
  if (npm > 1e6) return 0.0008;
  if (npm > 3e5) return 0.0014;
  if (npm > 5e4) return 0.0026;
  return 0.0045;                           // thin: wide spread, expensive to cross
}
// total round-trip friction (mk optional; falls back to FX + a small default spread)
function frictionPct(sym, profile, mk) {
  if (!profile || profile.name !== 'real') return 0;
  const spread = mk ? spreadPct(mk, profile) : (/\.L$/.test(String(sym)) ? 0.0015 : 0.0010);
  return fxPct(sym, profile) + spread;
}
// Pick the profile: explicit override wins; otherwise any LIVE account or any small
// pot (< £2,000) gets the conservative profile automatically. So a real £100 account
// is protected the moment it connects, with zero extra configuration.
function activeProfile(equity, isLive) {
  if (isLive) return PROFILES.real;   // REAL MONEY is always conservative — no env override can change that
  const forced = (process.env.TRADING_PROFILE || 'auto').toLowerCase();
  if (forced === 'real') return PROFILES.real;
  if (forced === 'practice') return PROFILES.practice;
  if (equity != null && isFinite(equity) && equity < 2000) return PROFILES.real;
  return PROFILES.practice;
}

module.exports = {
  FALLBACK_UNIVERSE: [...US, ...ETF, ...UK, ...EU],
  NAMES, venue, marketOpen, nextOpenInfo, minsToClose,
  PROFILES, activeProfile, frictionPct, VARIANT,
  PORT: 3100,
  SCAN_MS: 350,            // one Yahoo fetch per 350ms, rotating open-market symbols
  HOT_EVERY: 2,            // every 2nd scan slot goes to the hot list — holdings/spikes refresh faster
  TRADER_TICK_MS: 1500,    // evaluate the whole board every 1.5s (was 2.5) — faster spike reaction
  TV_MS: 25000,            // TradingView analyst: one market scanned per 25s, 8 markets rotating
  LOGGER_MS: 60000,
  NEWS_MS: 90000,
  CONGRESS_MS: 6 * 3600e3,
  AUTH_RETRY_MS: 10 * 60e3, // retry T212 connect every 10 min until it works
  MAX_OPEN: 10,            // max simultaneous positions (very high conviction only)
  T212_MIN_ORDER: 1.5,
  T212_SPACING_MS: 2600,
  PAPER_START: 10000,      // internal virtual ledger used until T212 connects

  // ——— SYSTEM X2 ———
  // RISK GUARDIAN — percentage-based so it protects a £10,000 practice account and
  // a £100 real account identically (£100 → hard halt the moment equity < £90).
  RISK: {
    MAX_DRAWDOWN: 0.10,    // total loss floor: equity < 90% of baseline → HALT + LIQUIDATE
    DAILY_MAX_LOSS: 0.06,  // one bad day: -6% from day start → pause entries until tomorrow
    PER_TRADE_CAP: 0.90,   // one position may never exceed 90% of equity
  },
  CRYPTO_MS: 1600,         // Binance spot klines: one coin per 1.6s, 24/7
  CRYPTOTV_MS: 30000,      // TradingView crypto screener sweep (multi-timeframe)
  COMMOD_MS: 4000,         // commodity futures via Yahoo (Globex trades ~23h Sun-Fri)
  LIVENEWS_MS: 180000,     // FT/Guardian/Economist/BBC/YouTube deep news
  HISTORY_MS: 6000,        // long-horizon analyst: one symbol per 6s, monthly data to 1927
  RANKER_MS: 4200,         // whole-universe ranker: slow background pass, weekly candles
  ALLOC_MS: 5000,          // order queue: fire queued conviction at the venue's open bell
  SENTINEL_MS: 45000,      // constant checker: state integrity + API health + sanity
  MEDIC_MS: 30000,         // self-healer: heartbeats, stall detection, auto-restart
  MARKETMAP_MS: 30000,
  QUEUE_MIN_CONF: 0.55,    // minimum conviction to queue an order for next open
};
