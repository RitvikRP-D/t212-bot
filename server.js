#!/usr/bin/env node
'use strict';
/*
 * T212 VIRTUAL TRADER — separate project, PRACTICE ACCOUNT ONLY.
 * Agents: ① scanner (Yahoo 1-min candles, market-hours aware, hot-list priority)
 *         ② news + congress disclosures  ③ trader (T212 practice orders, self-learning)
 *         ④ logger (xlsx + csv + Google Sheets webhook)  ⑤ TradingView bridge
 * Dashboard: http://localhost:3100 (phone: same Wi-Fi, port 3100)
 * SAFETY: demo.trading212.com hard-coded — the real-money account is unreachable.
 */
require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PORT, PAPER_START, nextOpenInfo } = require('./config');
const { fallback } = require('./lib/universe');

const DATA = path.join(__dirname, 'bot-data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
const STATE_FILE = path.join(DATA, 'state.json');

let state = {
  paper: { balance: PAPER_START, positions: {} },
  t212: { positions: {} },
  realized: 0, history: [], learn: {}, equityCurve: [], pause: false,
  startedAt: new Date().toISOString(),
};
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); console.log('[state] loaded'); }
catch (e) { console.log('[state] fresh start — $' + PAPER_START + ' virtual ledger'); }

let dirty = false;
const bus = {
  market: {}, state, news: {},
  universe: fallback(),
  markDirty: () => { dirty = true; },
  onTick: null, onTrade: null,
};
setInterval(() => { if (dirty) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {} dirty = false; } }, 5000);
bus.saveNow = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); dirty = false; } catch (e) {} };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {} process.exit(0); });

// Cloud mode: GitHub Actions jobs must end before the 6h hard limit, so exit
// cleanly after MAX_RUN_MINUTES; the next scheduled run restores state and continues.
const maxMin = parseFloat(process.env.MAX_RUN_MINUTES || '0');
if (maxMin > 0) setTimeout(() => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
  console.log(`[server] ${maxMin} min run window done — exiting cleanly for next scheduled run`);
  process.exit(0);
}, maxMin * 60000);

// ——— SYSTEM X2 fleet ———
require('./agents/risk').start(bus);        // ⑦ risk guardian (10% hard floor) — first, so gates exist
require('./agents/news').start(bus);        // ② market news + congress
require('./agents/livenews').start(bus);    // ⑬ FT/Guardian/Economist/BBC + Bloomberg/CNBC video desks
require('./agents/stocks').start(bus);      // ① 1-min scanner, 16k universe
require('./agents/crypto').start(bus);      // ⑩ crypto 24/7 (Binance + crypto news + ETP mapping)
require('./agents/commodities').start(bus); // ⑫ gold/silver/oil/copper… 24 targets via ~23h futures
require('./agents/tvanalyst').start(bus);   // ⑥ TradingView stocks analyst (8 markets)
require('./agents/cryptotv').start(bus);    // ⑪ TradingView crypto analyst (multi-timeframe, ~10.5k metrics)
require('./agents/history').start(bus);     // ⑭ historian — monthly data back to 1927
require('./agents/ranker').start(bus);      // ⑮ whole-universe leaderboard
require('./agents/marketmap').start(bus);   // ⑯ venue air-traffic control
require('./agents/earnings').start(bus);    // ⑲ earnings blackout calendar (real profile)
require('./agents/trader').start(bus);      // ③ the trader (T212 practice orders)
require('./agents/allocator').start(bus);   // ⑰ overnight order queue → fires at the bell
require('./agents/sentinel').start(bus);    // ⑨ constant checker / auto-repair
require('./agents/medic').start(bus);       // ⑧ self-healer / fleet supervisor
require('./agents/logger').start(bus);      // ④ xlsx + csv + Google Sheet
require('./agents/alerts').start(bus);      // ⑱ email alerts (after logger: wraps onTrade)
require('./agents/tradingview').start(bus); // ⑤ optional local TradingView-app bridge

function lanIP() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function snapshot() {
  const positions = [];
  for (const [ledger, book] of [['T212-PRACTICE', state.t212.positions], ['VIRTUAL', state.paper.positions]])
    for (const [sym, p] of Object.entries(book)) {
      const cur = bus.market[sym]?.price ?? p.entry;
      positions.push({ ledger, sym, entry: p.entry, cur, qty: p.qty, invested: p.invested,
        upnl: +((cur - p.entry) * p.qty).toFixed(2), opened: p.opened, conf: p.conf, reason: p.reason });
    }
  let openVal = 0; for (const p of positions) if (p.ledger === 'T212-PRACTICE') openVal += p.cur * p.qty;
  const closed = state.history.filter(h => h.pnl != null);
  const wins = closed.filter(h => h.pnl > 0).length;
  const top = Object.entries(bus.market).filter(([, m]) => m.price != null)
    .sort((a, b) => (b[1].lastConf || 0) - (a[1].lastConf || 0)).slice(0, 30)
    .map(([sym, m]) => {
      const tvr = bus.tvRatings && bus.tvRatings[sym];
      return { sym, price: m.price, pct24h: m.pct24h, rsi: m.rsi, lastConf: m.lastConf || 0, lastWhy: m.lastWhy || '…', lastTick: m.lastTick, tv: !!m.tvWatching,
        tvLabel: tvr ? tvr.label : null, tvRec: tvr ? +tvr.rec.toFixed(2) : null, tvName: tvr ? tvr.tvName : null };
    });
  const cryptoTop = Object.entries(bus.crypto || {}).filter(([, v]) => v.price)
    .sort((a, b) => (b[1].conf || 0) - (a[1].conf || 0)).slice(0, 12)
    .map(([coin, v]) => ({ coin, price: v.price, pct24h: v.pct24h, rsi: v.rsi, conf: v.conf || 0, why: v.why, etp: v.etp || null }));
  const commodTop = Object.entries(bus.commod || {}).filter(([, v]) => v.price)
    .sort((a, b) => (b[1].conf || 0) - (a[1].conf || 0)).slice(0, 12)
    .map(([key, v]) => ({ key, price: v.price, pct24h: v.pct24h, rsi: v.rsi, conf: v.conf || 0, etp: v.etp || null, etpName: v.etpName || null }));
  return {
    time: new Date().toLocaleTimeString(), pause: state.pause,
    t212: bus.t212Status, scan: bus.scanStatus, log: bus.logStatus, tv: bus.tvStatus, tva: bus.tvaStatus,
    risk: bus.riskStatus, medic: bus.medicStatus, sentinel: bus.sentinelStatus,
    crypto: { status: bus.cryptoStatus, top: cryptoTop, news: { global: (bus.cryptoNews || {}).global, updated: (bus.cryptoNews || {}).updated, headlines: ((bus.cryptoNews || {}).headlines || []).slice(0, 5) } },
    cryptoTV: bus.ctvStatus, commodities: { status: bus.commodStatus, top: commodTop },
    deepNews: { global: (bus.deepNews || {}).global, perTopic: (bus.deepNews || {}).perTopic, sources: (bus.deepNews || {}).sources, updated: (bus.deepNews || {}).updated, headlines: ((bus.deepNews || {}).headlines || []).slice(0, 6) },
    historian: bus.histStatus, ranker: bus.rankStatus, marketMap: bus.marketMap, alloc: bus.allocStatus,
    earnings: { count: (bus.earnings || {}).count, updated: (bus.earnings || {}).updated }, alerts: bus.alertStatus,
    queue: Object.entries(state.queue || {}).map(([sym, q]) => ({ sym, ...q })),
    newsAgent: { updated: bus.news.updated, headlines: (bus.news.headlines || []).length, congress: (bus.news.congress || []).length },
    paperCash: +state.paper.balance.toFixed(2),
    realized: +state.realized.toFixed(2),
    equity: bus.t212Status?.connected ? +((bus.t212Status?.cash || 0) + openVal).toFixed(2) : +(state.paper.balance).toFixed(2),
    openCount: positions.length, closedCount: closed.length,
    winRate: closed.length ? Math.round(wins / closed.length * 100) : null,
    universe: bus.universe.length,
    nextOpens: nextOpenInfo(),
    market: top, positions,
    history: state.history.slice(0, 30),
    news: { fng: bus.news.fng, global: bus.news.global, feedsOk: bus.news.feedsOk, headlines: (bus.news.headlines || []).slice(0, 10), congress: (bus.news.congress || []).slice(0, 8), congressTop: (bus.news.congressTop || []).slice(0, 12), congressUpdated: bus.news.congressUpdated },
    learn: Object.entries(state.learn).filter(([k]) => k.endsWith(':ALL')).map(([k, v]) => ({ signal: k.replace(':ALL', ''), ...v })),
    equityCurve: state.equityCurve.slice(-240),
    lan: lanIP() + ':' + PORT,
  };
}
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/' || req.url === '/index.html') {
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'))); }
    catch (e) { res.writeHead(500); return res.end('dashboard missing'); }
  }
  if (req.url === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify(snapshot())); }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
    const iv = setInterval(() => { try { res.write('data: ' + JSON.stringify(snapshot()) + '\n\n'); } catch (e) {} }, 900);
    req.on('close', () => clearInterval(iv));
    return;
  }
  if (req.url === '/api/pause' && req.method === 'POST') {
    state.pause = !state.pause; bus.markDirty();
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ pause: state.pause }));
  }
  if (req.url === '/api/resume' && req.method === 'POST') {
    state.pause = false; bus.markDirty();
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ pause: false }));
  }
  // KILL SWITCH — pause + liquidate everything at market, from the dashboard or phone
  if (req.url === '/api/kill' && req.method === 'POST') {
    state.pause = true; bus.markDirty();
    if (bus.liquidateAll) bus.liquidateAll('manual kill switch (dashboard)');
    if (bus.notify) bus.notify('🛑 KILL switch pressed on dashboard — liquidating + paused.');
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ killed: true, paused: true }));
  }
  res.writeHead(404, cors); res.end('not found');
});
server.on('error', (e) => { console.error('[server]', e.message); setTimeout(() => process.exit(1), 3000); });
server.listen(PORT, '0.0.0.0', () => console.log(`[server] http://localhost:${PORT} | phone: http://${lanIP()}:${PORT}`));
