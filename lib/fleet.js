'use strict';
// Shared fleet helpers: sector + country classification (for diversification caps) and
// a couple of small math utilities used across the newer agents. Fail-open: an unknown
// symbol maps to 'other'/'US' so a missing entry never blocks a trade.

// Curated sector map for the liquid names the real profile actually trades. Covers the
// fallback universe + common large caps; sector ETFs map to the sector they represent.
const SECTOR = {
  // mega-cap tech / semis / software
  AAPL:'tech', MSFT:'tech', GOOGL:'tech', GOOG:'tech', AMZN:'tech', NVDA:'semis', META:'tech', TSLA:'auto',
  AVGO:'semis', ORCL:'tech', CRM:'tech', ADBE:'tech', CSCO:'tech', ACN:'tech', TXN:'semis', QCOM:'semis',
  INTC:'semis', IBM:'tech', AMD:'semis', MU:'semis', AMAT:'semis', LRCX:'semis', KLAC:'semis', ADI:'semis',
  NXPI:'semis', ON:'semis', ARM:'semis', SMCI:'tech', DELL:'tech', HPQ:'tech', WDC:'semis', STX:'semis',
  NFLX:'tech', NOW:'tech', PANW:'tech', SNOW:'tech', SHOP:'tech', PYPL:'tech', PLTR:'tech', CRWD:'tech',
  ZS:'tech', DDOG:'tech', NET:'tech', MDB:'tech', TEAM:'tech', OKTA:'tech', TWLO:'tech', SPOT:'tech',
  PINS:'tech', SNAP:'tech', ETSY:'tech', EBAY:'tech', UBER:'tech', ABNB:'tech', COIN:'finance', TSM:'semis', ENPH:'energy', FSLR:'energy',
  // finance
  JPM:'finance', V:'finance', MA:'finance', BAC:'finance', WFC:'finance', GS:'finance', MS:'finance',
  C:'finance', AXP:'finance', SCHW:'finance', BLK:'finance', SPGI:'finance', 'BRK-B':'finance', MMC:'finance',
  // healthcare
  UNH:'health', JNJ:'health', LLY:'health', MRK:'health', ABBV:'health', TMO:'health', ABT:'health',
  DHR:'health', PFE:'health', AMGN:'health', MDT:'health', ISRG:'health', BMY:'health', GILD:'health',
  // consumer
  WMT:'consumer', PG:'consumer', KO:'consumer', PEP:'consumer', COST:'consumer', MCD:'consumer', HD:'consumer',
  LOW:'consumer', NKE:'consumer', SBUX:'consumer', DIS:'consumer', BKNG:'consumer', MAR:'consumer', HLT:'consumer',
  // energy / industrials / materials
  XOM:'energy', CVX:'energy', COP:'energy', SLB:'energy', BA:'industrials', CAT:'industrials', GE:'industrials',
  HON:'industrials', RTX:'industrials', UPS:'industrials', DE:'industrials', LIN:'materials', UNP:'industrials',
  // autos / airlines
  F:'auto', GM:'auto', RIVN:'auto', LCID:'auto', NIO:'auto', XPEV:'auto', LI:'auto',
  DAL:'airlines', UAL:'airlines', AAL:'airlines', CCL:'travel', RCL:'travel',
  // telecom / utilities / reits
  T:'telecom', VZ:'telecom', NEE:'utilities', SO:'utilities', DUK:'utilities',
  O:'reit', SPG:'reit', AMT:'reit', CCI:'reit', EQIX:'reit', PSA:'reit', DLR:'reit', WELL:'reit', AVB:'reit', EQR:'reit', PLD:'reit',
  // sector ETFs
  XLK:'tech', SOXX:'semis', SMH:'semis', XLF:'finance', XLV:'health', XLE:'energy', XLI:'industrials',
  XLP:'consumer', XLY:'consumer', XLU:'utilities', XLB:'materials', XLRE:'reit', JETS:'airlines', XBI:'health', ARKK:'tech',
  GLD:'gold', SLV:'gold', USO:'energy', UNG:'energy',
  // broad index ETFs -> 'index' (not counted against a single sector cap)
  SPY:'index', QQQ:'index', IWM:'index', DIA:'index', VTI:'index', VOO:'index', IVV:'index',
  VEA:'index', VWO:'index', EEM:'index', EFA:'index', VGK:'index',
};

const CTY = { L:'UK', DE:'DE', PA:'FR', AS:'NL', SW:'CH', MI:'IT', MC:'ES' };

function base(sym) { return String(sym).split('.')[0]; }
function sectorOf(sym) { return SECTOR[base(sym)] || 'other'; }
function countryOf(sym) { const p = String(sym).split('.'); return p.length > 1 ? (CTY[p[1]] || p[1]) : 'US'; }

module.exports = { sectorOf, countryOf };
