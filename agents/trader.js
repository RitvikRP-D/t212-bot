'use strict';
// AGENT ③: the trader. Confidence-sized entries, adaptive exits, self-learning.
// Executes REAL orders on the Trading212 PRACTICE account when connected;
// until then trades an internal $10,000 virtual ledger. Retries auth every 10 min.
const t212 = require('../lib/t212');
const { evaluate } = require('../lib/indicators');
const { fromInstruments, fallback } = require('../lib/universe');
const { TRADER_TICK_MS, T212_MIN_ORDER, AUTH_RETRY_MS, MAX_OPEN, marketOpen, frictionPct } = require('../config');

function now() { return new Date().toLocaleTimeString(); }

function start(bus) {
  const state = bus.state;
  bus.t212Status = { connected: false, scheme: null, cash: null, total: null, mapped: 0, lastError: 'connecting…', orders: 0, lastAttempt: null };
  const t212Ticker = {}; // yahoo sym -> t212 ticker

  async function tryConnect() {
    bus.t212Status.lastAttempt = now();
    const keyId = process.env.T212_API_KEY_ID, secret = process.env.T212_API_SECRET;
    if (!keyId || !secret) { bus.t212Status.lastError = 'no keys in .env'; return; }
    const res = await t212.connect(keyId, secret);
    if (!res.ok) { bus.t212Status.lastError = res.error; console.log('[t212] ' + res.error); return; }
    bus.t212Status.connected = true;
    bus.t212Status.scheme = res.scheme;
    bus.t212Status.lastError = null;
    console.log('[t212] CONNECTED to PRACTICE account via ' + res.scheme);
    try {
      const c = await t212.cash();
      if (c.status === 200) {
        bus.t212Status.cash = c.body.free != null ? c.body.free : c.body.total;
        bus.t212Status.total = c.body.total;
      }
    } catch (e) {}
    await expandUniverse();
    reconcile();
  }
  const CACHE_FILE = require('path').join(__dirname, '..', 'bot-data', 'instruments-cache.json');
  function loadFromCache() {
    if (bus.universe.length > 1000) return; // already expanded
    try {
      const fs = require('fs');
      if (!fs.existsSync(CACHE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (!Array.isArray(raw)) return;
      const { universe, skipped } = fromInstruments(raw);
      if (universe.length > bus.universe.length) {
        bus.universe = universe;
        for (const u of universe) t212Ticker[u.y] = u.t212;
        bus.t212Status.mapped = Object.keys(t212Ticker).length;
        console.log(`[t212] universe loaded from CACHE: ${universe.length} instruments (${skipped} unmappable skipped) — no API wait`);
      }
    } catch (e) { console.log('[t212] cache load failed: ' + e.message); }
  }
  async function expandUniverse() {
    if (bus.universe.length > 1000) return; // already expanded
    try {
      const inst = await t212.instruments();
      if (inst.status === 200 && Array.isArray(inst.body)) {
        const { universe, skipped } = fromInstruments(inst.body);
        if (universe.length > bus.universe.length) {
          bus.universe = universe;
          for (const u of universe) t212Ticker[u.y] = u.t212;
          console.log(`[t212] universe expanded to ${universe.length} instruments from your practice account (${skipped} unmappable skipped)`);
        }
        bus.t212Status.mapped = Object.keys(t212Ticker).length;
        // refresh the on-disk cache so restarts are instant
        try { require('fs').writeFileSync(CACHE_FILE, JSON.stringify(inst.body)); } catch (e) {}
      } else {
        console.log('[t212] instruments fetch HTTP ' + inst.status + ' — using cache, will retry');
      }
    } catch (e) { console.log('[t212] instruments fetch failed — using cache, will retry: ' + e.message); }
  }
  loadFromCache();   // instant 16k universe from disk — no API dependency
  tryConnect();
  setInterval(() => { if (!t212.connected()) tryConnect(); }, AUTH_RETRY_MS);
  setInterval(() => { if (t212.connected()) expandUniverse(); }, 3 * 60e3); // keep retrying until the 16k universe lands

  async function reconcile() {
    if (!t212.connected()) return;
    try {
      const c = await t212.cash();
      if (c.status === 200) {
        bus.t212Status.cash = c.body.free != null ? c.body.free : c.body.total;
        bus.t212Status.total = c.body.total;
      }
      const p = await t212.portfolio();
      if (p.status === 200 && Array.isArray(p.body)) {
        const seen = new Set();
        const rev = {};
        for (const [y, t] of Object.entries(t212Ticker)) rev[t] = y;
        for (const pos of p.body) {
          seen.add(pos.ticker);
          const local = Object.values(state.t212.positions).find(x => x.t212Ticker === pos.ticker);
          if (local) { local.qty = pos.quantity; local.entry = pos.averagePrice; continue; }
          // position exists on T212 but not locally (fresh cloud run / lost state) — adopt it so exits keep working
          const sym = rev[pos.ticker];
          if (sym) {
            state.t212.positions[sym] = { t212Ticker: pos.ticker, entry: pos.averagePrice, qty: pos.quantity,
              invested: +(pos.averagePrice * pos.quantity).toFixed(2), opened: 'recovered', peak: pos.averagePrice,
              conf: 0, sigType: 'adopted', reason: 'recovered from T212 account after restart' };
            console.log('[t212] adopted existing position ' + pos.ticker);
          }
        }
        for (const [sym, pos] of Object.entries(state.t212.positions))
          if (!seen.has(pos.t212Ticker) && !pos.pendingFill) delete state.t212.positions[sym];
      }
    } catch (e) {}
  }
  setInterval(reconcile, 60000);

  // ORDER JANITOR: any order still unfilled after 3 min is stuck (holiday, halt,
  // illiquid book) — cancel it so it can't sit there blocking capital.
  async function sweepStuckOrders() {
    if (!t212.connected()) return;
    try {
      const r = await t212.orders();
      if (r.status !== 200 || !Array.isArray(r.body)) return;
      for (const o of r.body) {
        const ageMin = (Date.now() - new Date(o.createdAt).getTime()) / 60000;
        if (ageMin < 3 || (o.filledQuantity || 0) > 0) continue;
        const c = await t212.cancelOrder(o.id);
        if (c.status === 200) {
          console.log(`[janitor] cancelled stuck order ${o.id} ${o.ticker} (${ageMin.toFixed(0)}min unfilled)`);
          for (const [sym, p] of Object.entries(state.t212.positions))
            if (p.t212Ticker === o.ticker) { delete state.t212.positions[sym]; bus.markDirty(); }
        }
      }
    } catch (e) {}
  }
  setInterval(sweepStuckOrders, 4 * 60e3);
  setTimeout(sweepStuckOrders, 60e3); // first sweep fast — clean up any mess from a previous run

  function learnKey(sig, sym) { return sig + ':' + sym; }
  function learnMul(sig, sym) {
    const L = state.learn[learnKey(sig, sym)];
    if (!L || L.wins + L.losses < 3) return 1;
    return 0.5 + L.wins / (L.wins + L.losses);
  }
  function learnRecord(sig, sym, pnl) {
    for (const key of [learnKey(sig, sym), learnKey(sig, 'ALL')]) {
      const L = state.learn[key] = state.learn[key] || { wins: 0, losses: 0, pnl: 0 };
      pnl >= 0 ? L.wins++ : L.losses++;
      L.pnl = +(L.pnl + pnl).toFixed(2);
    }
  }
  function pushHist(h) { state.history.unshift(h); state.history = state.history.slice(0, 500); bus.markDirty(); if (bus.onTrade) bus.onTrade(h); }
  function openCount() { return Object.keys(state.paper.positions).length + Object.keys(state.t212.positions).length; }
  function sentiFor(sym) {
    let s = (bus.news.perKey && bus.news.perKey[sym]) || 0;
    const cb = bus.news.congressBoost && bus.news.congressBoost[sym.split('.')[0]];
    if (cb) s += Math.max(-1, Math.min(1, cb * 0.15));
    return +s.toFixed(2);
  }

  async function tryEnter(sym, mk) {
    const senti = sentiFor(sym);
    const ev = evaluate(mk, senti, bus.news.fng ? bus.news.fng.value : null, 1);
    if (!ev) { mk.lastConf = 0; mk.lastWhy = mk.rsi != null ? `no buy setup — RSI ${mk.rsi.toFixed(1)}${mk.rsi > 68 ? ' overbought' : ''}` : 'warming up'; return; }
    const lm = learnMul(ev.sigType, sym);
    let conf = Math.max(0, Math.min(1, ev.conf * lm));
    let tvNote = '';
    const tvr = bus.tvRatings && bus.tvRatings[sym];
    if (tvr && Date.now() - tvr.at < 30 * 60e3) {
      conf = Math.max(0, Math.min(1, conf + tvr.rec * 0.15));
      tvNote = ` · TradingView says ${tvr.label} (${tvr.rec.toFixed(2)})${tvr.detail ? ': ' + tvr.detail : ''}`;
    }
    // SYSTEM X2 fleet inputs —
    // historian: never fight a century of trend
    const lt = bus.longTerm && bus.longTerm[sym];
    if (lt && Date.now() - lt.at < 25 * 3600e3) {
      conf = Math.max(0, Math.min(1, conf + (lt.regime > 0 ? 0.05 : -0.10)));
      tvNote += ` · ${lt.note}`;
    }
    // universe ranker: leaderboard names earn a bonus
    if (bus.rankTop && bus.rankTop.has(sym)) { conf = Math.min(1, conf + 0.05); tvNote += ' · top-150 universe rank'; }
    // allocator: conviction queued overnight fires with its stored confidence
    if (mk.queuedBoost && Date.now() < mk.queuedBoost.until) {
      conf = Math.max(conf, mk.queuedBoost.conf);
      tvNote += ' · ' + mk.queuedBoost.reason;
    }
    // ACTIVE PROFILE (practice vs real) — set by the risk guardian from live-ness + size.
    const prof = bus.profile || { name: 'practice', perTradeCap: 0.90, sizeBase: 0.20, sizeSlope: 0.70, maxOpen: MAX_OPEN, minConf: 0.55, nonGbpPenalty: 0, minNotionalPerMin: 0, preferGBP: false };
    // FEE-AWARE NUDGE: on a real GBP account, non-GBP names cost ~0.15%/side in FX —
    // dock their confidence so fee-free LSE (.L) names win ties.
    if (prof.nonGbpPenalty && !/\.L$/.test(sym)) conf = Math.max(0, conf - prof.nonGbpPenalty);
    mk.lastConf = +conf.toFixed(2);
    mk.lastWhy = ev.reasons.join(' · ') + (lm !== 1 ? ` · learning ×${lm.toFixed(2)}` : '') + tvNote + (prof.name === 'real' ? ' · [real profile]' : '');
    // EVERY instrument on T212 is exchange-listed (crypto ETPs & commodity ETCs trade on
    // LSE/Xetra too) — so NOTHING trades on a closed venue. One rule for all: venue must be
    // open by the clock. This is the hard guarantee against the holiday-order trap.
    if (state.pause || conf < prof.minConf || !marketOpen(sym) || openCount() >= prof.maxOpen) return;
    if (bus.riskGate && !bus.riskGate.canEnter()) return; // RISK GUARDIAN gate
    // LIQUIDITY GATE (real money): skip thin names whose fills would be eaten by spread.
    if (prof.minNotionalPerMin && (mk.notionalPerMin == null || mk.notionalPerMin < prof.minNotionalPerMin)) {
      mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ too illiquid for real money';
      return;
    }
    // FEE-REACH GATE (real money): if the name is too calm to plausibly move past the
    // fee hurdle (round-trip friction + target net), there's no profit to be had — skip.
    const entryFriction = frictionPct(sym, prof);
    if (prof.name === 'real') {
      const reach = (mk.atrPct || 0) * 15;   // rough reachable favorable move over the hold
      if (reach < entryFriction + (prof.minNetProfit || 0)) {
        mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ move too small to beat fees';
        return;
      }
    }
    // SECOND, INDEPENDENT GUARD: the clock can still say "open" on an unlisted exchange
    // holiday (learned on July 4th — 26 orders blocked £9,996). So also require the newest
    // 1-min bar to be genuinely fresh: no live prints = closed = never send an order.
    if (!mk.lastBarAt || Date.now() - mk.lastBarAt > 20 * 60e3) {
      mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ venue prints stale (holiday/halt?) — not risking a blocked order';
      return;
    }

    if (t212.connected() && t212Ticker[sym]) {
      if (state.t212.positions[sym]) return;
      const cash = bus.t212Status.cash || 0;
      const frac = Math.min(prof.perTradeCap, prof.sizeBase + conf * prof.sizeSlope); // profile-scaled size
      const reserve = Math.max(2, cash * 0.02);          // keep a small cash reserve for fees/slippage
      let invest = Math.min(cash * frac, cash - reserve);
      if (bus.riskGate) invest = bus.riskGate.capInvest(invest); // never > profile per-trade cap of equity
      if (invest < T212_MIN_ORDER) return;
      const qty = +(invest / mk.price).toFixed(4);
      if (qty <= 0) return;
      state.t212.positions[sym] = { t212Ticker: t212Ticker[sym], entry: mk.price, qty, invested: invest, opened: now(), openedAt: Date.now(), peak: mk.price, conf, sigType: ev.sigType, reason: mk.lastWhy, pendingFill: true };
      // T212 instruments differ in allowed quantity precision — retry coarser on 400
      let r = await t212.marketOrder(t212Ticker[sym], qty);
      for (const dp of [2, 1, 0]) {
        if (r.status !== 400 || !/precision/i.test(JSON.stringify(r.body))) break;
        const q2 = +(invest / mk.price).toFixed(dp);
        if (q2 <= 0) break;
        state.t212.positions[sym].qty = q2;
        r = await t212.marketOrder(t212Ticker[sym], q2);
      }
      if (r.status === 200) {
        state.t212.positions[sym].pendingFill = false;
        bus.t212Status.orders++;
        bus.t212Status.cash = Math.max(0, cash - invest);
        pushHist({ t: now(), sym, ledger: 'T212-PRACTICE', action: 'BUY', price: mk.price, qty: state.t212.positions[sym].qty, pnl: null, why: `${mk.lastWhy} — conf ${(conf*100).toFixed(0)}%, ~${invest.toFixed(2)} → REAL order on practice account (check your T212 app)` });
        console.log(`[trade] T212 BUY ${t212Ticker[sym]} qty=${state.t212.positions[sym].qty}`);
      } else {
        delete state.t212.positions[sym];
        bus.t212Status.lastError = `order rejected HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`;
        console.log('[t212] ' + bus.t212Status.lastError);
      }
      return;
    }
    // internal virtual ledger until T212 connects
    const sp = state.paper;
    if (sp.positions[sym]) return;
    const frac = Math.min(0.6, 0.05 + conf * 0.55);
    const invest = Math.min(sp.balance, Math.max(20, sp.balance * frac));
    if (invest < 10) return;
    sp.balance -= invest;
    sp.positions[sym] = { entry: mk.price, qty: invest / mk.price, invested: invest, opened: now(), peak: mk.price, conf, sigType: ev.sigType, reason: mk.lastWhy };
    pushHist({ t: now(), sym, ledger: 'VIRTUAL', action: 'BUY', price: mk.price, qty: invest / mk.price, pnl: null, why: `${mk.lastWhy} — conf ${(conf*100).toFixed(0)}%, $${invest.toFixed(2)} (internal ledger, T212 not connected yet)` });
    console.log(`[trade] VIRTUAL BUY ${sym} $${invest.toFixed(2)}`);
  }

  function exitCheck(sym) {
    const mk = bus.market[sym];
    if (!mk || mk.price == null) return;
    for (const [book, ledger] of [[state.t212.positions, 'T212-PRACTICE'], [state.paper.positions, 'VIRTUAL']]) {
      const p = book[sym];
      if (!p || p.pendingFill) continue;
      if (mk.price > p.peak) p.peak = mk.price;
      const gain = (mk.price - p.entry) / p.entry;
      const peakGain = (p.peak - p.entry) / p.entry;
      const ns = sentiFor(sym);
      const prof = bus.profile || { stopLoss: 0.018, minHoldMin: 0, minNetProfit: 0 };
      const heldMin = p.openedAt ? (Date.now() - p.openedAt) / 60000 : 999;
      const matured = heldMin >= (prof.minHoldMin || 0);   // min-hold reduces fee-churn on real money
      // FEE HURDLE: gross gain must clear the round-trip friction before it's a REAL profit.
      const friction = frictionPct(sym, prof);
      const tpFloor = friction + (prof.minNetProfit || 0);  // don't bank a "profit" that fees would eat
      const netGain = gain - friction;                      // what you actually keep
      let stop = -(prof.stopLoss || 0.018), mode = 'stop loss';
      if (mk.atrPct != null && mk.atrPct > 0.0009) { stop = -Math.min(0.04, Math.max(0.012, mk.atrPct * 22)); mode = 'ATR-sized stop'; }
      if (ns >= 0.5 && (mk.rsi == null || mk.rsi < 50)) { stop = -0.06; mode = 'wide stop (positive news, riding dip)'; }
      // trailing only ARMS once we're safely above the fee hurdle, and never trails to a
      // level that would lock in a net loss (floor the trail at friction + a hair).
      if (peakGain > tpFloor + 0.015) { stop = Math.max(peakGain - 0.015, friction + 0.002); mode = 'trailing stop (net-positive)'; }
      if (stop < -0.08) stop = -0.08;
      let why = null;
      // capital protection ALWAYS fires (stop loss / trailing / bad news) regardless of hold time;
      // discretionary profit-taking waits until matured AND net-of-fees positive.
      if (gain <= stop) why = stop > 0 ? `${mode}: locked +${(netGain*100).toFixed(2)}% net (peak +${(peakGain*100).toFixed(2)}%)` : `${mode} at ${(gain*100).toFixed(2)}%`;
      else if (ns <= -1.5 && gain > -0.02) why = `bad news flow (${ns}) — exiting at ${(netGain*100).toFixed(2)}% net`;
      else if (matured && gain > tpFloor && mk.rsi != null && mk.rsi > 70 && mk.crossDown) why = `overbought RSI ${mk.rsi.toFixed(1)} — banking +${(netGain*100).toFixed(2)}% net`;
      else if (matured && gain > tpFloor) {
        const tvx = bus.tvRatings && bus.tvRatings[sym];
        if (tvx && Date.now() - tvx.at < 30 * 60e3 && tvx.rec <= -0.5)
          why = `TradingView flipped to STRONG SELL (${tvx.rec.toFixed(2)}) — banking +${(netGain*100).toFixed(2)}% net`;
      }
      if (why) closePos(sym, ledger, book, p, mk, why);
    }
  }
  async function closePos(sym, ledger, book, p, mk, why) {
    const gross = (mk.price - p.entry) * p.qty;
    // subtract estimated round-trip friction (FX + spread) so realized P&L is TRUE net profit
    const fee = frictionPct(sym, bus.profile) * (p.invested || p.entry * p.qty);
    const pnl = gross - fee;
    if (ledger === 'T212-PRACTICE') {
      p.pendingFill = true;
      const r = await t212.marketOrder(p.t212Ticker, -p.qty);
      if (r.status !== 200) { p.pendingFill = false; bus.t212Status.lastError = `sell rejected HTTP ${r.status}`; return; }
      bus.t212Status.orders++;
      delete book[sym];
    } else {
      state.paper.balance += p.qty * mk.price;
      delete book[sym];
    }
    state.realized += pnl;
    learnRecord(p.sigType, sym, pnl);
    pushHist({ t: now(), sym, ledger, action: 'SELL', price: mk.price, qty: p.qty, pnl: +pnl.toFixed(2), why });
    console.log(`[trade] ${ledger} SELL ${sym} pnl=${pnl.toFixed(2)}`);
    bus.markDirty();
  }
  bus.onTick = exitCheck;
  bus.tryEnter = tryEnter;   // allocator fires queued conviction through here at the bell
  // RISK GUARDIAN authority: close everything at market, immediately
  bus.liquidateAll = async (reason) => {
    console.log('[trader] LIQUIDATE ALL — ' + reason);
    for (const [sym, p] of Object.entries({ ...state.t212.positions })) {
      const mk = bus.market[sym] || { price: p.entry };
      await closePos(sym, 'T212-PRACTICE', state.t212.positions, p, mk, 'LIQUIDATED: ' + reason);
    }
    for (const [sym, p] of Object.entries({ ...state.paper.positions })) {
      const mk = bus.market[sym] || { price: p.entry };
      closePos(sym, 'VIRTUAL', state.paper.positions, p, mk, 'LIQUIDATED: ' + reason);
    }
  };

  setInterval(() => {
    for (const [sym, mk] of Object.entries(bus.market)) {
      if (mk.price == null || mk.rsi == null) continue;
      tryEnter(sym, mk);
    }
  }, TRADER_TICK_MS);

  setInterval(() => {
    let open = 0;
    for (const [s, p] of Object.entries(state.paper.positions)) open += (bus.market[s]?.price || p.entry) * p.qty;
    for (const [s, p] of Object.entries(state.t212.positions)) open += (bus.market[s]?.price || p.entry) * p.qty;
    state.equityCurve.push({ t: Date.now(), eq: +(state.paper.balance + (bus.t212Status.cash || 0) + open).toFixed(2) });
    state.equityCurve = state.equityCurve.slice(-2880);
    bus.markDirty();
  }, 30000);
  console.log('[trader] agent started');
}
module.exports = { start };
