'use strict';
// AGENT ③: the trader. Confidence-sized entries, adaptive exits, self-learning.
// Executes REAL orders on the Trading212 PRACTICE account when connected;
// until then trades an internal $10,000 virtual ledger. Retries auth every 10 min.
const t212 = require('../lib/t212');
const { evaluate } = require('../lib/indicators');
const { fromInstruments, fallback } = require('../lib/universe');
const { TRADER_TICK_MS, T212_MIN_ORDER, AUTH_RETRY_MS, MAX_OPEN, marketOpen, frictionPct, minsToClose, VARIANT } = require('../config');
const { sectorOf, countryOf } = require('../lib/fleet');

function now() { return new Date().toLocaleTimeString(); }

// Pearson correlation of two price series' returns (overlapping tail) — used to avoid
// stacking positions that move in lockstep. Returns 0 when there's not enough overlap.
function returnsCorr(a, b) {
  const n = Math.min(a.length, b.length, 60);
  if (n < 20) return 0;
  const ta = a.slice(-n), tb = b.slice(-n), ra = [], rb = [];
  for (let i = 1; i < n; i++) { ra.push((ta[i] - ta[i - 1]) / ta[i - 1]); rb.push((tb[i] - tb[i - 1]) / tb[i - 1]); }
  const mean = arr => arr.reduce((x, y) => x + y, 0) / arr.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { const x = ra[i] - ma, y = rb[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
}

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
    // PINE SMITH (agent ⑳): fold the broadcast multi-indicator confluence in as a small,
    // bounded confirmation (±0.02 — same weight as the fee nudge; never an override).
    if (bus.pine && bus.pine[sym]) {
      const p = bus.pine[sym];
      conf = Math.max(0, Math.min(1, conf + Math.max(-0.02, Math.min(0.02, p.bias * 0.02))));
      tvNote += ` · Pine ${p.net >= 0 ? '+' : ''}${p.net} confluence`;
    }

    // ——— CONSENSUS VOTES (#1) — which independent agents back this entry ———
    const votes = ['signal'];
    if (tvr && Date.now() - tvr.at < 30 * 60e3 && tvr.rec > 0.15) votes.push('tv');
    if (lt && Date.now() - lt.at < 25 * 3600e3 && lt.regime > 0) votes.push('historian');
    if (bus.rankTop && bus.rankTop.has(sym)) votes.push('ranker');
    if (bus.pine && bus.pine[sym] && bus.pine[sym].net >= 2) votes.push('pine');
    if (senti > 0.2) votes.push('news');
    if (bus.news.congressBoost && bus.news.congressBoost[sym.split('.')[0]] > 0) votes.push('congress');
    if ((mk.volSurge || 0) > 1.8) votes.push('volume');
    mk.lastVotes = votes;

    // ——— ENTRY TIMING (#8) — don't catch a falling knife on reversal setups ———
    const reversalSig = /RSI_OVERSOLD|RSI_DIP|DIP_REVERSAL|BB_BOUNCE/.test(ev.sigType || '');
    const cl = mk.closes;
    const turningUp = cl && cl.length >= 2 && cl[cl.length - 1] >= cl[cl.length - 2];
    let timingBlock = false;
    if (reversalSig && !turningUp) { if (prof.name === 'real') timingBlock = true; else conf *= 0.85; }

    // ——— SIGNAL TIME-DECAY (#9) — a setup that's been live a while without triggering is stale ———
    if (!mk._sig || mk._sig.type !== ev.sigType) mk._sig = { type: ev.sigType, at: Date.now() };
    const sigAgeMin = (Date.now() - mk._sig.at) / 60000;
    if (sigAgeMin > 8) { conf *= Math.max(0.8, 1 - (sigAgeMin - 8) / 40 * 0.2); tvNote += ` · signal ${sigAgeMin.toFixed(0)}m old`; }

    // ——— REGIME + VOLATILITY (#5/#10) — scale conviction to the tape ———
    const reg = bus.regime;
    if (reg && reg.mult) { conf *= reg.mult.conf; if (reg.state && reg.state !== 'unknown') tvNote += ` · ${reg.state}`; }

    // ——— DRAWDOWN RECOVERY (#4) — below baseline but above the hard floor: trade smaller/pickier ———
    const recovering = bus.riskStatus && bus.riskStatus.recovery;
    if (recovering) { conf *= 0.9; tvNote += ' · recovery mode'; }

    conf = Math.max(0, Math.min(1, conf));
    mk.lastConf = +conf.toFixed(2);
    mk.lastWhy = ev.reasons.join(' · ') + (lm !== 1 ? ` · learning ×${lm.toFixed(2)}` : '') + tvNote + (prof.name === 'real' ? ' · [real profile]' : '');
    // EVERY instrument on T212 is exchange-listed (crypto ETPs & commodity ETCs trade on
    // LSE/Xetra too) — so NOTHING trades on a closed venue. One rule for all: venue must be
    // open by the clock. This is the hard guarantee against the holiday-order trap.
    const minConf = prof.minConf + (recovering ? 0.10 : 0);   // recovery mode demands a bigger edge
    if (state.pause || conf < minConf || !marketOpen(sym) || openCount() >= prof.maxOpen) return;
    if (timingBlock) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ still falling — waiting for the turn'; return; }
    if (votes.length < (prof.consensusMin || 1)) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ only ${votes.length} agent vote${votes.length === 1 ? '' : 's'} (need ${prof.consensusMin})`; return; }
    if (bus.perfBlocked && bus.perfBlocked()) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ performance cool-off'; return; }
    if (bus.riskGate && !bus.riskGate.canEnter()) return; // RISK GUARDIAN gate
    // LIQUIDITY GATE (real money): skip thin names whose fills would be eaten by spread.
    if (prof.minNotionalPerMin && (mk.notionalPerMin == null || mk.notionalPerMin < prof.minNotionalPerMin)) {
      mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ too illiquid for real money';
      return;
    }
    // FEE-REACH GATE (real money): if the name is too calm to plausibly move past the
    // fee hurdle (round-trip friction + target net), there's no profit to be had — skip.
    const entryFriction = frictionPct(sym, prof, mk);
    if (prof.name === 'real') {
      const reach = (mk.atrPct || 0) * 15;   // rough reachable favorable move over the hold
      if (reach < entryFriction + (prof.minNetProfit || 0)) {
        mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ move too small to beat fees';
        return;
      }
      // EARNINGS BLACKOUT: never open a position within 2 days of the company reporting.
      const ed = bus.earningsInDays ? bus.earningsInDays(sym) : null;
      if (ed != null && ed <= 2 && ed >= 0) {
        mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ earnings in ${ed}d — blackout`;
        return;
      }
      // CORRELATION CAP: don't stack a bet that moves in lockstep with something we hold
      // (that's the same risk twice, not diversification).
      for (const heldSym of Object.keys(state.t212.positions)) {
        const hc = bus.market[heldSym] && bus.market[heldSym].closes;
        if (hc && mk.closes && returnsCorr(mk.closes, hc) > 0.85) {
          mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ moves in lockstep with ${heldSym}`;
          return;
        }
      }
      // SECTOR / COUNTRY DIVERSIFICATION CAP (#6): don't let the book pile into one theme.
      const held = Object.keys(state.t212.positions);
      if (held.length >= 2) {
        const afterN = held.length + 1;
        const sec = sectorOf(sym), cty = countryOf(sym);
        if (sec !== 'index' && sec !== 'other') {
          const sameSec = held.filter(h => sectorOf(h) === sec).length + 1;
          if (sameSec / afterN > prof.sectorCap) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ ${sec} already ${Math.round(sameSec / afterN * 100)}% of book`; return; }
        }
        const sameCty = held.filter(h => countryOf(h) === cty).length + 1;
        if (sameCty / afterN > prof.countryCap) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ ${cty} already ${Math.round(sameCty / afterN * 100)}% of book`; return; }
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
      const sizeMul = (reg && reg.mult ? reg.mult.size : 1) * (recovering ? 0.5 : 1);   // regime + recovery shrink size
      const frac = Math.min(prof.perTradeCap, (prof.sizeBase + conf * prof.sizeSlope) * sizeMul);
      const reserve = Math.max(2, cash * 0.02);          // keep a small cash reserve for fees/slippage
      let invest = Math.min(cash * frac, cash - reserve);
      if (bus.riskGate) invest = bus.riskGate.capInvest(invest); // never > profile per-trade cap of equity
      if (invest < T212_MIN_ORDER) return;
      const qty = +(invest / mk.price).toFixed(4);
      if (qty <= 0) return;
      state.t212.positions[sym] = { t212Ticker: t212Ticker[sym], entry: mk.price, intendedPrice: mk.price, qty, origQty: qty, invested: invest, opened: now(), openedAt: Date.now(), peak: mk.price, conf, sigType: ev.sigType, reason: mk.lastWhy, votes, variant: VARIANT, pendingFill: true };
      // REAL money uses a MARKETABLE LIMIT — priced a hair through the spread so it fills
      // immediately but can never pay more than +0.3% above mid (caps slippage on 16k names).
      // PRACTICE uses a plain market order. Falls back to market if the venue rejects the limit.
      const useLimit = prof.name === 'real';
      const limitPx = +(mk.price * 1.003).toFixed(mk.price > 50 ? 2 : mk.price > 1 ? 3 : 5);
      const send = (q) => useLimit ? t212.limitOrder(t212Ticker[sym], q, limitPx) : t212.marketOrder(t212Ticker[sym], q);
      // T212 instruments differ in allowed quantity precision — retry coarser on 400
      let r = await send(qty);
      for (const dp of [2, 1, 0]) {
        if (r.status !== 400 || !/precision/i.test(JSON.stringify(r.body))) break;
        const q2 = +(invest / mk.price).toFixed(dp);
        if (q2 <= 0) break;
        state.t212.positions[sym].qty = q2;
        r = await send(q2);
      }
      // limit rejected for a non-quantity reason (tick size etc.) → fall back to market so the signal still trades
      if (useLimit && r.status !== 200) r = await t212.marketOrder(t212Ticker[sym], state.t212.positions[sym].qty);
      if (r.status === 200) {
        state.t212.positions[sym].pendingFill = false;
        bus.t212Status.orders++;
        bus.t212Status.cash = Math.max(0, cash - invest);
        pushHist({ t: now(), sym, ledger: 'T212-PRACTICE', action: 'BUY', price: mk.price, qty: state.t212.positions[sym].qty, pnl: null, votes, cond: { rsi: mk.rsi != null ? +mk.rsi.toFixed(1) : null, regime: reg ? reg.state : null, sector: sectorOf(sym), atrPct: mk.atrPct }, why: `${mk.lastWhy} — conf ${(conf*100).toFixed(0)}%, votes[${votes.join(',')}], ~${invest.toFixed(2)} → REAL order on practice account (check your T212 app)` });
        console.log(`[trade] T212 BUY ${t212Ticker[sym]} qty=${state.t212.positions[sym].qty}`);
      } else {
        delete state.t212.positions[sym];
        bus.t212Status.lastError = `order rejected HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`;
        // DEAD-LETTER (#12): hand the failed order to the auditor to surface + alert
        (bus.deadLetter = bus.deadLetter || []).push({ sym, ticker: t212Ticker[sym], error: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 100)}`, t: now(), at: Date.now() });
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
      const friction = frictionPct(sym, prof, mk);
      const tpFloor = friction + (prof.minNetProfit || 0);  // don't bank a "profit" that fees would eat
      const netGain = gain - friction;                      // what you actually keep
      const edx = (prof.name === 'real' && bus.earningsInDays) ? bus.earningsInDays(sym) : null;  // days to earnings
      const rDist = Math.min(0.04, Math.max(0.012, (mk.atrPct || 0.0015) * 22));   // ~1R risk distance
      const regStop = (bus.regime && bus.regime.mult ? bus.regime.mult.stop : 1);
      const phaseMul = heldMin < 10 ? 0.85 : heldMin < 30 ? 1.1 : 1.0;             // DYNAMIC STOP by hold phase (#18)
      let stop = -(prof.stopLoss || 0.018), mode = 'stop loss';
      if (mk.atrPct != null && mk.atrPct > 0.0009) { stop = -Math.min(0.05, rDist * regStop * phaseMul); mode = 'ATR/regime stop'; }
      if (ns >= 0.5 && (mk.rsi == null || mk.rsi < 50)) { stop = Math.min(stop, -0.06); mode = 'wide stop (positive news, riding dip)'; }
      // BREAKEVEN+ LOCK (#18): once comfortably net-positive, never hand it back to a loss
      if (matured && netGain > tpFloor + 0.006) { stop = Math.max(stop, friction + 0.001); mode = 'breakeven+ lock'; }
      // trailing arms once safely above the fee hurdle, never trails into a net loss
      if (peakGain > tpFloor + 0.015) { stop = Math.max(peakGain - 0.015, friction + 0.002); mode = 'trailing stop (net-positive)'; }
      if (p.overnightLock) stop = Math.max(stop, friction + 0.001);                // held overnight → protect it
      if (stop < -0.08) stop = -0.08;
      // PROFIT LADDER (#19): bank in thirds as it works, let the final third run.
      if (ledger === 'T212-PRACTICE' && (bus.profile || {}).ladder && matured && gain > tpFloor) {
        if (!p.ladder1 && gain >= rDist * 1.0) { p.ladder1 = true; scaleOut(sym, book, p, mk, 1 / 3, `ladder +1R — banked ⅓ (+${(netGain*100).toFixed(2)}% net)`); return; }
        if (p.ladder1 && !p.ladder2 && gain >= rDist * 1.5) { p.ladder2 = true; scaleOut(sym, book, p, mk, 0.5, `ladder +1.5R — banked another ⅓`); return; }
      }
      const mtc = ((bus.profile || {}).name === 'real') ? minsToClose(sym) : null;   // minutes to venue close
      let why = null;
      // capital protection ALWAYS fires (stop loss / trailing / bad news) regardless of hold time;
      // discretionary profit-taking waits until matured AND net-of-fees positive.
      if (gain <= stop) why = stop > 0 ? `${mode}: locked +${(netGain*100).toFixed(2)}% net (peak +${(peakGain*100).toFixed(2)}%)` : `${mode} at ${(gain*100).toFixed(2)}%`;
      else if (edx != null && edx >= 0 && edx <= 1) why = `earnings in ${edx}d — going flat before the gap (${(netGain*100).toFixed(2)}% net)`;
      else if (ns <= -1.5 && gain > -0.02) why = `bad news flow (${ns}) — exiting at ${(netGain*100).toFixed(2)}% net`;
      // OVERNIGHT HOLD DECISION (#20): near the close, only carry a green, non-earnings winner
      // in a trending tape (with its stop tightened); otherwise flatten to dodge the gap.
      else if (mtc != null && mtc <= 12) {
        if (netGain <= 0.001) why = `flat before the close — not carrying a red position overnight (${(netGain*100).toFixed(2)}%)`;
        else if (!(bus.profile || {}).overnightHold) why = `banking +${(netGain*100).toFixed(2)}% net before the close`;
        else if (bus.regime && bus.regime.state === 'trend' && matured) { p.overnightLock = true; }   // hold, protected
        else why = `banking +${(netGain*100).toFixed(2)}% net before the close (no trend to carry)`;
      }
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
    const fee = frictionPct(sym, bus.profile, mk) * (p.invested || p.entry * p.qty);
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
  // PARTIAL SELL for the profit ladder — sells `fraction` of the CURRENT qty, books that
  // slice's net P&L, keeps the rest running. Only used on the T212 book.
  async function scaleOut(sym, book, p, mk, fraction, why) {
    const q = +(p.qty * fraction).toFixed(4);
    if (q <= 0 || q >= p.qty) return;
    const r = await t212.marketOrder(p.t212Ticker, -q);
    if (r.status !== 200) { (bus.deadLetter = bus.deadLetter || []).push({ sym, error: `ladder sell HTTP ${r.status}`, t: now(), at: Date.now() }); return; }
    bus.t212Status.orders++;
    const gross = (mk.price - p.entry) * q;
    const fee = frictionPct(sym, bus.profile, mk) * (p.entry * q);
    const pnl = gross - fee;
    p.qty = +(p.qty - q).toFixed(4);
    state.realized += pnl;
    learnRecord(p.sigType, sym, pnl);
    pushHist({ t: now(), sym, ledger: 'T212-PRACTICE', action: 'SELL', price: mk.price, qty: q, pnl: +pnl.toFixed(2), why });
    console.log(`[trade] LADDER partial SELL ${sym} q=${q} pnl=${pnl.toFixed(2)}`);
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
    if (bus.beat) bus.beat('trader');
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
