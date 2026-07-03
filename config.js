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
};
function venue(sym){ const p = sym.split('.'); return p.length > 1 ? p[1] : 'US'; }
function marketOpen(sym){
  const h = HOURS[venue(sym)]; if (!h) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: h.tz, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  return mins >= h.open[0]*60 + h.open[1] && mins < h.close[0]*60 + h.close[1];
}
function nextOpenInfo(){
  const opens = [];
  for (const [v, h] of Object.entries(HOURS)) opens.push(`${v} ${String(h.open[0]).padStart(2,'0')}:${String(h.open[1]).padStart(2,'0')} ${h.tz.split('/')[1]}`);
  return opens.join(' · ');
}

module.exports = {
  FALLBACK_UNIVERSE: [...US, ...ETF, ...UK, ...EU],
  NAMES, venue, marketOpen, nextOpenInfo,
  PORT: 3100,
  SCAN_MS: 350,            // one Yahoo fetch per 350ms, rotating open-market symbols
  HOT_EVERY: 3,            // every 3rd scan slot goes to the hot list (holdings + high-confidence)
  TRADER_TICK_MS: 2500,
  LOGGER_MS: 60000,
  NEWS_MS: 90000,
  CONGRESS_MS: 6 * 3600e3,
  AUTH_RETRY_MS: 10 * 60e3, // retry T212 connect every 10 min until it works
  MAX_OPEN: 25,            // max simultaneous positions
  T212_MIN_ORDER: 1.5,
  T212_SPACING_MS: 2600,
  PAPER_START: 10000,      // internal virtual ledger used until T212 connects
};
