'use strict';
// AGENT ③: the trader. Confidence-sized entries, adaptive exits, self-learning.
// Executes REAL orders on the Trading212 PRACTICE account when connected;
// until then trades an internal $10,000 virtual ledger. Retries auth every 10 min.
const t212 = require('../lib/t212');
const { evaluate } = require('../lib/indicators');
const { fromInstruments, fallback } = require('../lib/universe');
const { TRADER_TICK_MS, T212_MIN_ORDER, AUTH_RETRY_MS, MAX_OPEN, marketOpen } = require('../config');

function now() { return new Date().toLocaleTimeString(); }

function start(bus) {
  const state = bus.state;
  bus.t212Status = { connected: false, scheme: null, cash: null, mapped: 0, lastError: 'connecting…', orders: 0, lastAttempt: null };
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
      if (c.status === 200) bus.t212Status.cash = c.body.free != null ? c.body.free : c.body.total;
    } catch (e) {}
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
      }
    } catch (e) {}
    reconcile();
  }
  tryConnect();
  setInterval(() => { if (!t212.connected()) tryConnect(); }, AUTH_RETRY_MS);

  async function reconcile() {
    if (!t212.connected()) return;
    try {
      const c = await t212.cash();
      if (c.status === 200) bus.t212Status.cash = c.body.free != null ? c.body.free : c.body.total;
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
    const conf = Math.max(0, Math.min(1, ev.conf * lm));
    mk.lastConf = +conf.toFixed(2);
    mk.lastWhy = ev.reasons.join(' · ') + (lm !== 1 ? ` · learning ×${lm.toFixed(2)}` : '');
    if (state.pause || conf < 0.22 || !marketOpen(sym) || openCount() >= MAX_OPEN) return;

    if (t212.connected() && t212Ticker[sym]) {
      if (state.t212.positions[sym]) return;
      const cash = bus.t212Status.cash || 0;
      const frac = Math.min(0.6, 0.05 + conf * 0.55); // cap 60% of cash per position
      const invest = Math.min(cash * frac, cash - 1);
      if (invest < T212_MIN_ORDER) return;
      const qty = +(invest / mk.price).toFixed(4);
      if (qty <= 0) return;
      state.t212.positions[sym] = { t212Ticker: t212Ticker[sym], entry: mk.price, qty, invested: invest, opened: now(), peak: mk.price, conf, sigType: ev.sigType, reason: mk.lastWhy, pendingFill: true };
      const r = await t212.marketOrder(t212Ticker[sym], qty);
      if (r.status === 200) {
        state.t212.positions[sym].pendingFill = false;
        bus.t212Status.orders++;
        bus.t212Status.cash = Math.max(0, cash - invest);
        pushHist({ t: now(), sym, ledger: 'T212-PRACTICE', action: 'BUY', price: mk.price, qty, pnl: null, why: `${mk.lastWhy} — conf ${(conf*100).toFixed(0)}%, ~${invest.toFixed(2)} → REAL order on practice account (check your T212 app)` });
        console.log(`[trade] T212 BUY ${t212Ticker[sym]} qty=${qty}`);
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
      let stop = -0.03, mode = 'stop loss';
      if (ns >= 0.5 && (mk.rsi == null || mk.rsi < 50)) { stop = -0.06; mode = 'wide stop (positive news, riding dip)'; }
      if (peakGain > 0.02) { stop = peakGain - 0.015; mode = 'trailing stop'; }
      if (stop < -0.08) stop = -0.08;
      let why = null;
      if (gain <= stop) why = stop > 0 ? `${mode}: locked +${(gain*100).toFixed(2)}% (peak +${(peakGain*100).toFixed(2)}%)` : `${mode} at ${(gain*100).toFixed(2)}%`;
      else if (mk.rsi != null && mk.rsi > 70 && mk.crossDown && gain > 0) why = `overbought RSI ${mk.rsi.toFixed(1)} — taking +${(gain*100).toFixed(2)}%`;
      else if (ns <= -1.5 && gain > -0.02) why = `bad news flow (${ns}) — exiting at ${(gain*100).toFixed(2)}%`;
      if (why) closePos(sym, ledger, book, p, mk, why);
    }
  }
  async function closePos(sym, ledger, book, p, mk, why) {
    const pnl = (mk.price - p.entry) * p.qty;
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
