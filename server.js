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
// Cloud hosts (Railway) resolve AAAA first but IPv6 egress to T212/Cloudflare hangs,
// so every fetch aborts at its timeout. Force IPv4 before anything opens a socket.
require('dns').setDefaultResultOrder('ipv4first');
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
  realized: 0, history: [], learn: {}, equityCurve: [], pause: false, blacklist: {},
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
  quiverKey: state.quiverKey || null,   // runtime Quiver key (dashboard-set), persisted in state
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
let lastDeadManFire = 0;
setInterval(() => {
  const now = Date.now();
  const minsSinceHealthy = (now - lastHealthy) / 60000;
  // pendingFill phantoms aren't real T212 holdings — liquidating them just spams
  // failed sells; reconcile's stale-phantom sweep is the correct cleanup for those.
  const realPos = Object.values(state.t212.positions).filter(p => p && !p.pendingFill).length;

  // Only check during market hours (rough: 7am-10pm UTC covers most markets)
  const hour = new Date().getUTCHours();
  const isMarketHours = hour >= 7 && hour < 22;

  // fire at most once per 30 min — re-firing every minute while the API is down
  // just floods the order queue with sells that can never complete
  if (isMarketHours && realPos > 0 && minsSinceHealthy > 60 && now - lastDeadManFire > 30 * 60e3) {
    lastDeadManFire = now;
    console.error(`[DEAD-MAN] No activity for ${minsSinceHealthy.toFixed(0)}m with ${realPos} open — auto-liquidating`);
    state.pause = true;
    state.pausedBy = 'deadman';   // reconcile auto-unpauses once the API is healthy again
    if (bus.liquidateAll) bus.liquidateAll(`dead-man switch: no activity for ${minsSinceHealthy.toFixed(0)}m`);
    if (bus.notify) bus.notify(`🚨 Dead-man switch triggered: no bot activity for 1+ hour. Liquidating ${realPos} open position(s).`);
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
require('./lib/fundamentals').start(bus);   // 📊 P/E, growth, D/E, dividends, margins for ~6k names (feeds the desks)
require('./agents/desks').start(bus);       // 🏦 10 institutional desks: Goldman/MS/Bridgewater/JPM/BlackRock/Citadel/Harvard/Bain/RenTech/McKinsey
require('./agents/quiver').start(bus);      // 🦌 Quiver Quantitative (OPTIONAL, key-gated) — congress trades + gov contracts
require('./agents/trumptrades').start(bus); // 🇺🇸 Trump trading desk — linked-equity map + policy themes + congress cross-ref + advisory signals
require('./agents/stocks').start(bus);      // ① 1-min scanner, 16k universe
require('./agents/crypto').start(bus);      // ⑩ crypto 24/7 (Binance + crypto news + ETP mapping)
require('./agents/commodities').start(bus); // ⑫ gold/silver/oil/copper… 24 targets via ~23h futures
require('./agents/commoditydesks').start(bus); // ⑫b eight commodity desks (energy/precious/agri/softs/industrial/battery/index/vol)
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
require('./agents/heartbeat').start(bus);   // ㉔ fleet liveness monitor (critical-agent alerts → bus.fleetProbe)
require('./agents/fleet').start(bus);       // 🖥 live per-agent board — every agent's real-time activity → bus.fleet
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
    .sort((a, b) => (b[1].conf || 0) - (a[1].conf || 0)).slice(0, 40)
    .map(([coin, v]) => {
      const tv = bus.tvCrypto && bus.tvCrypto[coin];
      return { coin, price: v.price, pct24h: v.pct24h, rsi: v.rsi, conf: v.conf || 0, why: v.why, etp: v.etp || null,
        tvLabel: tv ? tv.label : null, tvRec: tv ? tv.rec : null, tvDetail: tv ? tv.detail : null };
    });
  const commodTop = Object.entries(bus.commod || {}).filter(([, v]) => v.price)
    .sort((a, b) => (b[1].conf || 0) - (a[1].conf || 0)).slice(0, 12)
    .map(([key, v]) => ({ key, price: v.price, pct24h: v.pct24h, rsi: v.rsi, conf: v.conf || 0, etp: v.etp || null, etpName: v.etpName || null }));
  return {
    time: new Date().toLocaleTimeString(), pause: state.pause,
    t212: bus.t212Status, scan: bus.scanStatus, log: bus.logStatus, tv: bus.tvStatus, tva: bus.tvaStatus,
    risk: bus.riskStatus, medic: bus.medicStatus, sentinel: bus.sentinelStatus,
    crypto: { status: bus.cryptoStatus, top: cryptoTop, news: { global: (bus.cryptoNews || {}).global, updated: (bus.cryptoNews || {}).updated, headlines: ((bus.cryptoNews || {}).headlines || []).slice(0, 5) } },
    cryptoTV: bus.ctvStatus, commodities: { status: bus.commodStatus, top: commodTop },
    commodDesks: bus.commodDesks || null, commodDesksSummary: bus.commodDesksSummary || null,
    commodByType: (bus.newsRadar && bus.newsRadar.commodByType) || null,
    commodFeed: (bus.newsRadar && bus.newsRadar.commodFeed) || null,
    deepNews: { global: (bus.deepNews || {}).global, perTopic: (bus.deepNews || {}).perTopic, sources: (bus.deepNews || {}).sources, updated: (bus.deepNews || {}).updated, headlines: ((bus.deepNews || {}).headlines || []).slice(0, 6) },
    historian: bus.histStatus, ranker: bus.rankStatus, marketMap: bus.marketMap, alloc: bus.allocStatus,
    earnings: { count: (bus.earnings || {}).count, updated: (bus.earnings || {}).updated }, alerts: bus.alertStatus,
    pine: bus.pineStatus, regime: bus.regime, perf: bus.perf, audit: bus.audit, fleet: bus.fleet,
    newsRadar: bus.newsRadar ? { global: bus.newsRadar.global, sources: bus.newsRadar.sources, channels: bus.newsRadar.channels, total: bus.newsRadar.total, perTick: bus.newsRadar.perTick, cycles: bus.newsRadar.cycles, updated: bus.newsRadar.updated, byRegion: bus.newsRadar.byRegion, byEntity: bus.newsRadar.byEntity, bySource: bus.newsRadar.bySource, categories: bus.newsRadar.categories, headlines: (bus.newsRadar.headlines || []).slice(0, 80), trumpFeed: (bus.newsRadar.trumpFeed || []).slice(0, 20), cryptoFeed: (bus.newsRadar.cryptoFeed || []).slice(0, 20), cryptoByCoin: bus.newsRadar.cryptoByCoin, warBoard: bus.newsRadar.warBoard, warNarrative: bus.newsRadar.warNarrative } : null,
    newsBrain: bus.newsBrain ? { themes: bus.newsBrain.themes, sectors: bus.newsBrain.sectors, top: bus.newsBrain.top, calls: bus.newsBrain.calls, holdings: bus.newsBrain.holdings, narrative: bus.newsBrain.narrative, updated: bus.newsBrain.updated } : null,
    newsBridge: bus.newsBridge ? { aligned: bus.newsBridge.aligned, conflicts: bus.newsBridge.conflicts, updated: bus.newsBridge.updated } : null,
    newsCorrelations: bus.newsCorrelations ? bus.newsCorrelations.slice(0, 140) : null,
    newsCorrStatus: bus.newsCorrStatus || null,
    openBell: bus.openBell ? { lastOpened: bus.openBell.lastOpened, history: bus.openBell.history } : null,
    trumpAssets: (bus.newsRadar && bus.newsRadar.trumpAssets) || null,
    trump: bus.trump || null,
    quiver: bus.quiver || null,
    desks: bus.desks || null,
    fundStatus: bus.fundStatus || null,
    blacklist: Object.keys(state.blacklist || {}),
    queue: Object.entries(state.queue || {}).map(([sym, q]) => ({ sym, ...q })),
    newsAgent: { updated: bus.news.updated, headlines: (bus.news.headlines || []).length, congress: (bus.news.congress || []).length },
    paperCash: +state.paper.balance.toFixed(2),
    realized: +state.realized.toFixed(2),
    // T212's own account total is authoritative — free cash + blocked cash + invested
    // at THEIR prices. Local cash+openVal math drifts on stale prices/pending orders
    // (the audit agent kept flagging 8% divergence), so it is only a fallback.
    equity: bus.t212Status?.connected
      ? (isFinite(bus.t212Status?.total) && bus.t212Status.total > 0
          ? +bus.t212Status.total.toFixed(2)
          : +((bus.t212Status?.cash || 0) + openVal).toFixed(2))
      : +(state.paper.balance).toFixed(2),
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
    // X-Accel-Buffering:no stops reverse proxies (Railway edge) from buffering the
    // stream — without it frames can sit in the proxy and the page looks frozen.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');  // first frame immediately, not after 900ms
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
  // CLOSE ONE POSITION — sell a single holding at market from the dashboard
  if (req.url.startsWith('/api/close') && req.method === 'POST') {
    const sym = decodeURIComponent((req.url.split('sym=')[1] || '').split('&')[0]);
    const p = state.t212.positions[sym] || state.paper.positions[sym];
    if (!sym || !p) { res.writeHead(404, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ error: 'position not found: ' + sym })); }
    p.forceClose = true; bus.markDirty();
    if (bus.notify) bus.notify(`✂️ Manual close requested from dashboard: ${sym} — selling at market on next tick.`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ closing: sym }));
  }
  // BLACKLIST — block/unblock a symbol from ever being bought (from the dashboard)
  if (req.url.startsWith('/api/blacklist') && req.method === 'POST') {
    const q = req.url.split('?')[1] || '';
    const sym = decodeURIComponent((q.match(/sym=([^&]+)/) || [])[1] || '').toUpperCase();
    const remove = /action=remove/.test(q);
    if (!sym) { res.writeHead(400, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ error: 'sym required' })); }
    state.blacklist = state.blacklist || {};
    if (remove) delete state.blacklist[sym]; else state.blacklist[sym] = true;
    bus.markDirty();
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ blacklist: Object.keys(state.blacklist) }));
  }
  // RESCAN — manual "opening bell": re-analyse all held/tracked names right now
  if (req.url === '/api/rescan' && req.method === 'POST') {
    const names = [...new Set([...Object.keys(state.t212.positions || {}), ...Object.keys(bus.market || {})])];
    bus.tvHot = bus.tvHot || [];
    for (const s of names) if (!bus.tvHot.includes(s)) bus.tvHot.unshift(s);
    bus.tvHot = bus.tvHot.slice(0, 300);
    bus.freshOpen = { venue: 'MANUAL', label: 'dashboard rescan', at: Date.now(), names: names.length };
    if (bus.notify) bus.notify(`🔄 Manual re-analysis triggered from dashboard — ${names.length} names front-loaded.`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ rescanned: names.length }));
  }
  // QUIVER KEY — paste a Quiver API key from the dashboard; activates the connector live
  // (persisted in state, no redeploy). Send action=clear to remove it.
  if (req.url.startsWith('/api/quiver-key') && req.method === 'POST') {
    const q = req.url.split('?')[1] || '';
    const clear = /action=clear/.test(q);
    const key = decodeURIComponent((q.match(/key=([^&]+)/) || [])[1] || '').trim();
    if (clear) { state.quiverKey = null; bus.quiverKey = null; bus.markDirty(); res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ cleared: true })); }
    if (!key || key.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ error: 'key too short' })); }
    state.quiverKey = key; bus.quiverKey = key; bus.markDirty();
    if (bus.notify) bus.notify('🦌 Quiver API key saved — connector will validate on its next cycle (~1 min).');
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ saved: true, hint: 'validating on next quiver cycle (~1 min); watch the Quiver panel' }));
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
    state.risk.dayStart = +eq.toFixed(2);
    state.risk.realizedAtBaseline = state.realized || 0;   // keep auto-baseline drift math in sync
    state.risk.lastRealizedSnapshot = state.realized || 0;
    if (state.risk.halted) {
      state.risk.halted = false;
      state.risk.haltReason = null;
    }
    state.pause = false;
    bus.markDirty();
    if (bus.notify) bus.notify(`💰 Account rebalanced: baseline £${oldBaseline || '?'} → £${eq.toFixed(2)}`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ rebaseline: true, baseline: state.risk.baseline, eq }));
  }
  res.writeHead(404, cors); res.end('not found');
});
server.on('error', (e) => { console.error('[server]', e.message); setTimeout(() => process.exit(1), 3000); });
server.listen(PORT, '0.0.0.0', () => console.log(`[server] http://localhost:${PORT} | phone: http://${lanIP()}:${PORT}`));
