'use strict';
// AGENT ④: logger — three outputs:
//   1. Excel workbook  → RITVIK STOCKS/t212_trading_log.xlsx (rewritten every 60s)
//   2. CSV append      → t212-bot/bot-data/trades.csv (every trade, instantly)
//   3. Google Sheets   → live rows via Apps Script webhook (set GSHEET_WEBHOOK in .env;
//      see google-sheets-webhook.gs for the 3-minute setup). Free, no Google API keys.
// Reality check: 1 and 2 only update while this Mac is on. 3 updates a cloud sheet you
// can open from your phone — but rows are only SENT while the bot is running somewhere.
const fs = require('fs');
const path = require('path');
const { LOGGER_MS } = require('../config');
const MAC_XLSX = '/Users/ritvik_rp/Documents/Ritvik/RITVIK STOCKS/t212_trading_log.xlsx';
const XLSX_OUT = process.env.XLSX_OUT ? path.resolve(process.env.XLSX_OUT)
  : (fs.existsSync(path.dirname(MAC_XLSX)) ? MAC_XLSX : path.join(__dirname, '..', 'bot-data', 't212_trading_log.xlsx'));
const CSV_OUT = path.join(__dirname, '..', 'bot-data', 'trades.csv');

function start(bus) {
  let XLSX = null;
  try { XLSX = require('xlsx'); } catch (e) { console.log('[logger] xlsx package missing'); }
  bus.logStatus = { lastXlsx: null, csvRows: 0, sheetRows: 0, sheetError: null, webhook: !!process.env.GSHEET_WEBHOOK };

  if (!fs.existsSync(CSV_OUT)) fs.writeFileSync(CSV_OUT, 'time,ledger,symbol,action,price,qty,pnl,reason\n');

  async function postSheet(kind, row) {
    const url = process.env.GSHEET_WEBHOOK;
    if (!url) return;
    try {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, row }) });
      bus.logStatus.sheetRows++;
      bus.logStatus.sheetError = null;
    } catch (e) { bus.logStatus.sheetError = e.message; }
  }

  bus.onTrade = (h) => {
    const line = [h.t, h.ledger, h.sym, h.action, h.price, h.qty, h.pnl ?? '', String(h.why || '').replace(/[,\n]/g, ';')].join(',') + '\n';
    try { fs.appendFileSync(CSV_OUT, line); bus.logStatus.csvRows++; } catch (e) {}
    postSheet('trade', [h.t, h.ledger, h.sym, h.action, h.price, h.qty, h.pnl ?? '', h.why || '']);
  };

  function writeXlsx() {
    if (!XLSX) return;
    try {
      const s = bus.state;
      const wb = XLSX.utils.book_new();
      const sheet = rows => XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'nothing yet' }]);
      const openPos = [];
      for (const [ledger, book] of [['T212-PRACTICE', s.t212.positions], ['VIRTUAL', s.paper.positions]])
        for (const [sym, p] of Object.entries(book))
          openPos.push({ ledger, symbol: sym, entry: p.entry, current: bus.market[sym]?.price ?? '', qty: p.qty, invested: p.invested,
            unrealized: bus.market[sym]?.price ? +((bus.market[sym].price - p.entry) * p.qty).toFixed(2) : '', opened: p.opened, confidence: p.conf, reason: p.reason });
      XLSX.utils.book_append_sheet(wb, sheet([{
        updated: new Date().toLocaleString(),
        t212_connected: bus.t212Status.connected ? 'YES (practice)' : 'NO — ' + (bus.t212Status.lastError || ''),
        t212_cash: bus.t212Status.cash ?? '',
        virtual_ledger_cash: +s.paper.balance.toFixed(2),
        realized_pnl: +s.realized.toFixed(2),
        open_positions: openPos.length,
        closed_trades: s.history.filter(h => h.pnl != null).length,
        universe_size: bus.universe.length,
        markets_open_now: bus.scanStatus?.openNow ?? 0,
        note: 'Local files update only while the Mac is on. Google Sheet updates whenever the bot runs.',
      }]), 'Summary');
      XLSX.utils.book_append_sheet(wb, sheet(s.history.map(h => ({ time: h.t, ledger: h.ledger, symbol: h.sym, action: h.action, price: h.price, qty: h.qty, pnl: h.pnl, reason: h.why }))), 'Trades');
      XLSX.utils.book_append_sheet(wb, sheet(openPos), 'OpenPositions');
      const signals = Object.entries(bus.market).filter(([, m]) => (m.lastConf || 0) > 0)
        .sort((a, b) => b[1].lastConf - a[1].lastConf).slice(0, 100)
        .map(([sym, m]) => ({ symbol: sym, price: m.price, rsi: m.rsi != null ? +m.rsi.toFixed(1) : '', confidence: m.lastConf, read: m.lastWhy, at: m.lastTick }));
      XLSX.utils.book_append_sheet(wb, sheet(signals), 'Signals');
      XLSX.utils.book_append_sheet(wb, sheet((bus.news.headlines || []).map(h => ({ score: h.score, title: h.title, source: h.source }))), 'News');
      XLSX.utils.book_append_sheet(wb, sheet((bus.news.congress || []).slice(0, 100)), 'CongressTrades');
      XLSX.utils.book_append_sheet(wb, sheet(bus.state.equityCurve.slice(-500).map(p => ({ time: new Date(p.t).toLocaleString(), equity: p.eq }))), 'EquityCurve');
      // JOURNAL (#2/#15): each closed trade with its entry votes + exit post-mortem
      const buys = s.history.filter(h => h.action === 'BUY');
      const journal = s.history.filter(h => h.action === 'SELL' && h.pnl != null).slice(0, 200).map(sell => {
        const buy = buys.find(b => b.sym === sell.sym);
        return { time: sell.t, symbol: sell.sym, ledger: sell.ledger,
          entryVotes: buy && buy.votes ? buy.votes.join('+') : '', entrySector: buy && buy.cond ? buy.cond.sector : '',
          entryRegime: buy && buy.cond ? buy.cond.regime : '', netPnl: sell.pnl,
          outcome: sell.pnl > 0 ? 'WIN' : 'loss', exitReason: sell.why };
      });
      XLSX.utils.book_append_sheet(wb, sheet(journal), 'Journal');
      // SCORECARD (#16): per-agent + per-signal hit rates from the performance monitor
      const perf = bus.perf || {};
      const scoreRows = [
        { metric: 'win rate %', value: perf.winRate ?? '' }, { metric: 'closed trades', value: perf.closed ?? 0 },
        { metric: 'avg win', value: perf.avgWin ?? '' }, { metric: 'avg loss', value: perf.avgLoss ?? '' },
        { metric: 'profit factor', value: perf.profitFactor ?? '' }, { metric: 'loss streak', value: perf.streak ?? 0 },
        {}, { metric: '— PER AGENT —', value: '' },
        ...(perf.byAgent || []).map(a => ({ metric: 'agent ' + a.agent, value: `${a.rate ?? '?'}% (${a.wins}W/${a.losses}L, pnl ${a.pnl})` })),
        {}, { metric: '— PER SIGNAL —', value: '' },
        ...(perf.bySig || []).map(a => ({ metric: 'signal ' + a.sig, value: `${a.rate ?? '?'}% (${a.wins}W/${a.losses}L, pnl ${a.pnl})` })),
      ];
      XLSX.utils.book_append_sheet(wb, sheet(scoreRows), 'Scorecard');
      const tmp = XLSX_OUT.replace(/\.xlsx$/, '.tmp.xlsx');
      XLSX.writeFile(wb, tmp);
      fs.renameSync(tmp, XLSX_OUT);
      bus.logStatus.lastXlsx = new Date().toLocaleTimeString();
    } catch (e) { console.log('[logger] xlsx failed:', e.message); }
  }
  setTimeout(writeXlsx, 10000);
  setInterval(writeXlsx, LOGGER_MS);

  // Rich LIVE heartbeat to Google Sheet — frequent so the sheet visibly updates even
  // when the bot isn't trading (markets closed / no signal). Shows equity, what the bot
  // is watching, market status, mood — proof of life you can open from your phone.
  function heartbeat() {
    if (bus.beat) bus.beat('logger');
    const s = bus.state;
    const openN = Object.keys(s.t212.positions).length + Object.keys(s.paper.positions).length;
    const equity = bus.t212Status.connected ? +((bus.t212Status.cash || 0) + Object.entries(s.t212.positions)
      .reduce((a, [sym, p]) => a + (bus.market[sym]?.price || p.entry) * p.qty, 0)).toFixed(2) : +s.paper.balance.toFixed(2);
    // best current read across the whole universe
    const top = Object.entries(bus.market).filter(([, m]) => (m.lastConf || 0) > 0)
      .sort((a, b) => (b[1].lastConf || 0) - (a[1].lastConf || 0))[0];
    const topSig = top ? `${top[0]} ${(top[1].lastConf * 100).toFixed(0)}%` : '—';
    const cg = bus.news.congressTop && bus.news.congressTop[0];
    postSheet('summary', [
      new Date().toLocaleString(),
      bus.t212Status.connected ? 'T212 practice' : 'internal ledger',
      equity,
      bus.t212Status.cash ?? +s.paper.balance.toFixed(2),
      +s.realized.toFixed(2),
      openN,
      s.history.filter(h => h.pnl != null).length,
      bus.universe.length,
      bus.scanStatus?.openNow ?? 0,
      topSig,
      bus.news.global ?? '',
      bus.news.fng ? `${bus.news.fng.value} ${bus.news.fng.label}` : '',
      cg ? `congress: ${cg.ticker} ${cg.val.toFixed(2)}` : '',
      `${bus.riskStatus?.live ? 'LIVE£' : 'practice'}/${bus.riskStatus?.profile || '?'}${bus.riskStatus?.halted ? ' HALTED' : ''}`,
    ]);
  }
  setTimeout(heartbeat, 8000);       // first beat shortly after boot
  setInterval(heartbeat, 120000);    // then every 2 minutes
  console.log('[logger] agent started → xlsx + csv' + (process.env.GSHEET_WEBHOOK ? ' + Google Sheet (2-min live heartbeat)' : ' (Google Sheet: set GSHEET_WEBHOOK in .env)'));
}
module.exports = { start };
