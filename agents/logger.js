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
      const tmp = XLSX_OUT.replace(/\.xlsx$/, '.tmp.xlsx');
      XLSX.writeFile(wb, tmp);
      fs.renameSync(tmp, XLSX_OUT);
      bus.logStatus.lastXlsx = new Date().toLocaleTimeString();
    } catch (e) { console.log('[logger] xlsx failed:', e.message); }
  }
  setTimeout(writeXlsx, 10000);
  setInterval(writeXlsx, LOGGER_MS);

  // summary row to Google Sheet every 5 min
  setInterval(() => {
    const s = bus.state;
    postSheet('summary', [new Date().toLocaleString(), bus.t212Status.connected ? 'T212 connected' : 'internal ledger',
      bus.t212Status.cash ?? s.paper.balance, +s.realized.toFixed(2),
      Object.keys(s.t212.positions).length + Object.keys(s.paper.positions).length,
      s.history.filter(h => h.pnl != null).length]);
  }, 300000);
  console.log('[logger] agent started → xlsx + csv' + (process.env.GSHEET_WEBHOOK ? ' + Google Sheet' : ' (Google Sheet: set GSHEET_WEBHOOK in .env)'));
}
module.exports = { start };
