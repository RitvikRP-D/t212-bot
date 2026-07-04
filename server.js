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
const STATE_TEMP = STATE_FILE + '.tmp';

function atomicWriteState() {
  try {
    fs.writeFileSync(STATE_TEMP, JSON.stringify(state), 'utf8');
    fs.renameSync(STATE_TEMP, STATE_FILE);  // atomic swap
  } catch (e) { console.error('[state] atomic write failed:', e.message); }
}

let state = {
  paper: { balance: PAPER_START, positions: {} },
  t212: { positions: {} },
  realized: 0, history: [], learn: {}, equityCurve: [], pause: false,
  startedAt: new Date().toISOString(),
};
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  console.log('[state] loaded from ' + STATE_FILE);
} catch (e) {
  console.log('[state] fresh start — $' + PAPER_START + ' virtual ledger (load failed: ' + e.message + ')');
}

let dirty = false;
let lastHealthy = Date.now();  // track last successful trade/order
const bus = {
  market: {}, state, news: {},
  universe: fallback(),
  markDirty: () => { dirty = true; },
  onTick: null, onTrade: null,
  beats: {}, beat: (n) => { bus.beats[n] = Date.now(); },   // fleet heartbeat pings (medic also owns this)
  recordTrade: () => { lastHealthy = Date.now(); },  // called on successful order/trade
};

// AUTONOMOUS SAFETY: GitHub kill-switch file detection
// If you push a file named .emergency-halt to the repo, bot detects it on startup and liquidates
const EMERGENCY_HALT_FILE = path.join(__dirname, '.emergency-halt');
if (fs.existsSync(EMERGENCY_HALT_FILE)) {
  console.log('[SAFETY] Emergency halt file detected — liquidating all positions and pausing');
  state.pause = true;
  bus.liquidateAll = (reason) => {
    console.log('[liquidate] ' + reason);
    for (const [sym, p] of Object.entries(state.t212.positions)) {
      if (p && !p.pendingFill) p.pendingFill = true;
    }
  };
  if (bus.liquidateAll) bus.liquidateAll('emergency halt file detected');
  atomicWriteState();
  try { fs.unlinkSync(EMERGENCY_HALT_FILE); } catch (e) {}
}
setInterval(() => { if (dirty) { atomicWriteState(); dirty = false; } }, 5000);
bus.saveNow = () => { atomicWriteState(); dirty = false; };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { atomicWriteState(); process.exit(0); });

// AUTONOMOUS SAFETY: Dead-man's switch
// If no successful trade/reconcile for 1h+ during market hours, auto-liquidate (something is stuck)
setInterval(() => {
  const now = Date.now();
  const minsSinceHealthy = (now - lastHealthy) / 60000;
  const openPos = Object.keys(state.t212.positions).length;

  // Only check during market hours (rough: 7am-10pm UTC covers most markets)
  const hour = new Date().getUTCHours();
  const isMarketHours = hour >= 7 && hour < 22;

  if (isMarketHours && openPos > 0 && minsSinceHealthy > 60) {
    console.error(`[DEAD-MAN] No activity for ${minsSinceHealthy.toFixed(0)}m with ${openPos} open — auto-liquidating`);
    state.pause = true;
    if (bus.liquidateAll) bus.liquidateAll(`dead-man switch: no activity for ${minsSinceHealthy.toFixed(0)}m`);
    if (bus.notify) bus.notify(`🚨 Dead-man switch triggered: no bot activity for 1+ hour. Liquidating ${openPos} open position(s).`);
    atomicWriteState();
  }
}, 60000);  // check every 1 minute

// AUTONOMOUS HEALTH HEARTBEAT: verify bot is actually functioning
// Every 5 min, check: T212 connected, recent orders went through, state looks sane
setInterval(() => {
  const checks = [];

  // Check 1: T212 still connected
  checks.push({
    name: 'T212 connection',
    ok: bus.t212Status && bus.t212Status.connected,
    lastError: bus.t212Status ? bus.t212Status.lastError : 'no status'
  });

  // Check 2: Risk guardian alive
  checks.push({
    name: 'Risk guardian',
    ok: bus.riskStatus && bus.riskStatus.checked,
    lastError: !bus.riskStatus ? 'no status' : null
  });

  // Check 3: Market data flowing
  checks.push({
    name: 'Market data',
    ok: Object.keys(bus.market || {}).length > 10,
    lastError: 'market data stale'
  });

  const failures = checks.filter(c => !c.ok);
  if (failures.length >= 2 && Object.keys(state.t212.positions).length > 0) {
    console.error('[HEALTH] Critical checks failing:', failures.map(f => f.name).join(', '));
    if (bus.notify) bus.notify(`⚠️ Bot health check failed: ${failures.map(f => f.name).join(', ')}. Consider manual intervention.`);
  }
}, 300000);  // every 5 minutes

// STATUS PING: write "I'm alive" marker to the repo so you can check health
setInterval(() => {
  const statusFile = path.join(DATA, '.bot-status');
  const status = {
    alive: true,
    timestamp: new Date().toISOString(),
    connected: bus.t212Status?.connected || false,
    openPositions: Object.keys(state.t212.positions).length,
    equity: bus.t212Status?.total || state.paper.balance,
    lastTrade: new Date(lastHealthy).toISOString()
  };
  try {
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  } catch (e) { /* silent */ }
}, 60000);  // every 1 minute

// Cloud mode: GitHub Actions jobs must end before the 6h hard limit, so exit
// cleanly after MAX_RUN_MINUTES; the next scheduled run restores state and continues.
const maxMin = parseFloat(process.env.MAX_RUN_MINUTES || '0');
if (maxMin > 0) {
  // Warn 90s before the hard exit so agents can flush; then save + notify + exit. Positions
  // are intentionally CARRIED across runs (the next run's reconcile re-adopts them from T212),
  // so we never liquidate here — we just persist state and confirm a clean handoff.
  setTimeout(() => { try { if (bus.notify) bus.notify(`⏱️ Cloud run window ending — saving state and handing off to the next scheduled run. Open positions: ${Object.keys(state.t212.positions).length}.`); } catch (e) {} }, Math.max(0, maxMin * 60000 - 90000));
  setTimeout(() => {
    atomicWriteState();
    console.log(`[server] ${maxMin} min run window done — state saved, exiting cleanly for next scheduled run`);
    process.exit(0);
  }, maxMin * 60000);
}

// ——— SYSTEM X2 fleet ———
require('./agents/risk').start(bus);        // ⑦ risk guardian (10% hard floor) — first, so gates exist
require('./agents/news').start(bus);        // ② market news + congress
require('./agents/livenews').start(bus);    // ⑬ FT/Guardian/Economist/BBC + Bloomberg/CNBC video desks
require('./agents/newsradar').start(bus);   // 🅐 global 24/7 news radar (~60 desks: FT/Guardian/Economist/Reuters/Bloomberg/CNBC/WSJ + Trump/Truth Social + Asia/EU/US)
require('./agents/newsbrain').start(bus);   // 🅑 news interpreter — maps stories→instruments, grounds in ~century of history
require('./agents/newsbridge').start(bus);  // 🅒 news→fleet bridge — feeds interpreted news into trader votes + boards
require('./agents/newscorrelate').start(bus); // 🅓 correlator — every headline → affected stocks + direction + why, cross-checked vs TradingView
require('./agents/openbell').start(bus);    // 🔔 opening-bell trigger — fresh news+chart re-analysis the instant a venue opens
require('./agents/stocks').start(bus);      // ① 1-min scanner, 16k universe
require('./agents/crypto').start(bus);      // ⑩ crypto 24/7 (Binance + crypto news + ETP mapping)
require('./agents/commodities').start(bus); // ⑫ gold/silver/oil/copper… 24 targets via ~23h futures
require('./agents/tvanalyst').start(bus);   // ⑥ TradingView stocks analyst (8 markets)
require('./agents/cryptotv').start(bus);    // ⑪ TradingView crypto analyst (multi-timeframe, ~10.5k metrics)
require('./agents/history').start(bus);     // ⑭ historian — monthly data back to 1927
require('./agents/ranker').start(bus);      // ⑮ whole-universe leaderboard
require('./agents/marketmap').start(bus);   // ⑯ venue air-traffic control
require('./agents/earnings').start(bus);    // ⑲ earnings blackout calendar (real profile)
require('./agents/pine').start(bus);        // ⑳ Pine Smith — Pine v5 per stock, broadcasts confluence
require('./agents/regime').start(bus);      // ㉑ market regime + volatility detector
require('./agents/trader').start(bus);      // ③ the trader (T212 practice orders)
require('./agents/perf').start(bus);        // ㉒ performance monitor + per-agent scorecard
require('./agents/auditor').start(bus);     // ㉓ execution auditor + integrity watch
require('./agents/heartbeat').start(bus);   // ㉔ fleet liveness monitor
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
    pine: bus.pineStatus, regime: bus.regime, perf: bus.perf, audit: bus.audit, fleet: bus.fleet,
    newsRadar: bus.newsRadar ? { global: bus.newsRadar.global, sources: bus.newsRadar.sources, total: bus.newsRadar.total, updated: bus.newsRadar.updated, byRegion: bus.newsRadar.byRegion, byEntity: bus.newsRadar.byEntity, headlines: (bus.newsRadar.headlines || []).slice(0, 30), trumpFeed: (bus.newsRadar.trumpFeed || []).slice(0, 12) } : null,
    newsBrain: bus.newsBrain ? { themes: bus.newsBrain.themes, top: bus.newsBrain.top, updated: bus.newsBrain.updated } : null,
    newsBridge: bus.newsBridge ? { aligned: bus.newsBridge.aligned, conflicts: bus.newsBridge.conflicts, updated: bus.newsBridge.updated } : null,
    newsCorrelations: bus.newsCorrelations ? bus.newsCorrelations.slice(0, 60) : null,
    newsCorrStatus: bus.newsCorrStatus || null,
    openBell: bus.openBell ? { lastOpened: bus.openBell.lastOpened, history: bus.openBell.history } : null,
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
  if (req.url === '/' || req.url === '/index.html' || req.url === '/control' || req.url === '/control.html') {
    // new all-in-one control site is the default; old dashboard still at /legacy
    const file = (req.url.startsWith('/legacy')) ? 'dashboard.html' : 'control.html';
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(fs.readFileSync(path.join(__dirname, file))); }
    catch (e) {
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors }); return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'))); }
      catch (e2) { res.writeHead(500); return res.end('site missing'); }
    }
  }
  if (req.url === '/legacy' || req.url === '/legacy.html') {
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
  // PINE SMITH: list broadcast signals, or fetch one symbol's full Pine v5 script to paste into TradingView
  if (req.url.startsWith('/api/pine')) {
    const q = new URL(req.url, 'http://x').searchParams.get('sym');
    if (q) {
      const sym = q.toUpperCase();
      const script = bus.pineScript ? bus.pineScript(sym) : null;
      if (!script) { res.writeHead(404, { 'Content-Type': 'text/plain', ...cors }); return res.end(`no Pine script for ${sym} (not currently analysed)`); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
      return res.end(script);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ status: bus.pineStatus, signals: bus.pine || {} }));
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
  // REBASELINE — when you manually fund/withdraw the account, hit this to resync the risk floor
  if (req.url === '/api/rebaseline' && req.method === 'POST') {
    if (!bus.t212Status || !bus.t212Status.total) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'T212 not connected yet' }));
    }
    const eq = bus.t212Status.total;
    const oldBaseline = state.risk.baseline;
    state.risk.baseline = +eq.toFixed(2);
    if (state.risk.dayStart) {
      const scaleFactor = eq / (oldBaseline || eq);
      state.risk.dayStart = +(state.risk.dayStart * scaleFactor).toFixed(2);
    }
    state.risk.lastRealizedSnapshot = state.realized || 0;
    if (state.risk.halted) {
      state.risk.halted = false;
      state.risk.haltReason = null;
    }
    bus.markDirty();
    if (bus.notify) bus.notify(`💰 Account rebalanced: baseline £${oldBaseline || '?'} → £${eq.toFixed(2)}`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ rebaseline: true, baseline: state.risk.baseline, eq }));
  }
  res.writeHead(404, cors); res.end('not found');
});
server.on('error', (e) => { console.error('[server]', e.message); setTimeout(() => process.exit(1), 3000); });
server.listen(PORT, '0.0.0.0', () => console.log(`[server] http://localhost:${PORT} | phone: http://${lanIP()}:${PORT}`));
