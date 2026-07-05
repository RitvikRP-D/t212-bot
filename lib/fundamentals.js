'use strict';
// FUNDAMENTALS SWEEP — pulls valuation/balance-sheet/dividend columns from the same
// TradingView scanner the tvanalyst uses, across all 8 stock markets, so every desk
// agent (screener/DCF/dividend/moat/…) has real numbers for ~thousands of names.
// Falls back to a reduced column set if TV rejects an exotic field.
const MARKETS = [
  { id: 'america',     ex: ['NYSE', 'NASDAQ', 'AMEX', 'CBOE'], toY: n => n.replace(/\./g, '-') },
  { id: 'uk',          ex: ['LSE'],      toY: n => n.replace(/\./g, '-') + '.L' },
  { id: 'germany',     ex: ['XETR'],     toY: n => n + '.DE' },
  { id: 'france',      ex: ['EURONEXT'], toY: n => n + '.PA' },
  { id: 'netherlands', ex: ['EURONEXT'], toY: n => n + '.AS' },
  { id: 'switzerland', ex: ['SIX'],      toY: n => n + '.SW' },
  { id: 'italy',       ex: ['MIL'],      toY: n => n + '.MI' },
  { id: 'spain',       ex: ['BME'],      toY: n => n + '.MC' },
];
const CORE = ['close','market_cap_basic','price_earnings_ttm','earnings_per_share_basic_ttm','dividends_yield','debt_to_equity','gross_margin','operating_margin','net_margin','beta_1_year','sector','industry'];
const EXT = [...CORE,'total_revenue_yoy_growth_ttm','earnings_per_share_diluted_yoy_growth_ttm','dividend_payout_ratio_ttm','earnings_release_next_date','price_sales_ratio','price_book_ratio','return_on_equity','free_cash_flow_margin_ttm'];
const KEY = { close:'px', market_cap_basic:'mcap', price_earnings_ttm:'pe', earnings_per_share_basic_ttm:'eps', dividends_yield:'divY', debt_to_equity:'de', gross_margin:'gm', operating_margin:'om', net_margin:'nm', beta_1_year:'beta', sector:'sector', industry:'industry', total_revenue_yoy_growth_ttm:'revG', earnings_per_share_diluted_yoy_growth_ttm:'epsG', dividend_payout_ratio_ttm:'payout', earnings_release_next_date:'nextEarn', price_sales_ratio:'ps', price_book_ratio:'pb', return_on_equity:'roe', free_cash_flow_margin_ttm:'fcfM' };

function start(bus) {
  bus.fundamentals = {};
  bus.fundStatus = { names: 0, lastMarket: null, cols: EXT.length, errors: 0, updated: null };
  let cols = EXT, idx = 0;

  async function sweep(mkt) {
    const body = {
      filter: [
        { left: 'type', operation: 'in_range', right: ['stock'] },
        { left: 'exchange', operation: 'in_range', right: mkt.ex },
        { left: 'market_cap_basic', operation: 'greater', right: 100e6 },
      ],
      markets: [mkt.id], columns: ['name', ...cols],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, range: [0, 800],
    };
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(`https://scanner.tradingview.com/${mkt.id}/scan`, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        bus.fundStatus.errors++;
        if (cols === EXT) { cols = CORE; bus.fundStatus.cols = CORE.length; }  // shrink once, permanently
        return;
      }
      const j = await r.json();
      for (const row of j.data || []) {
        const d = {};
        row.d.forEach((v, i) => { if (i === 0) d.name = v; else d[KEY[cols[i - 1]] || cols[i - 1]] = v; });
        const y = mkt.toY(d.name);
        bus.fundamentals[y] = { ...d, y, at: Date.now() };
      }
      bus.fundStatus.names = Object.keys(bus.fundamentals).length;
      bus.fundStatus.lastMarket = mkt.id;
      bus.fundStatus.updated = new Date().toLocaleTimeString();
    } catch (e) { bus.fundStatus.errors++; } finally { clearTimeout(t); }
  }

  setInterval(() => sweep(MARKETS[idx++ % MARKETS.length]).catch(() => {}), 45000);
  sweep(MARKETS[0]).catch(() => {});
  console.log('[fundamentals] sweep armed — P/E, growth, D/E, dividends, margins, ROE for ~6k names across 8 markets');
}
module.exports = { start };
