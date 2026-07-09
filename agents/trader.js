'use strict';
// AGENT ③: the trader. Confidence-sized entries, adaptive exits, self-learning.
// Executes REAL orders on the Trading212 PRACTICE account when connected;
// until then trades an internal $10,000 virtual ledger. Retries auth every 10 min.
const t212 = require('../lib/t212');
const { evaluate } = require('../lib/indicators');
const { fromInstruments, fallback } = require('../lib/universe');
const { TRADER_TICK_MS, T212_MIN_ORDER, AUTH_RETRY_MS, MAX_OPEN, marketOpen, frictionPct, minsToClose, VARIANT, venue } = require('../config');
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
  const gbxTickers = new Set(); // t212 tickers quoted in GBX pence — their T212 prices need ÷100

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
    try { await fetchCash(); } catch (e) {}
    await expandUniverse();
    reconcile();
  }
  const CACHE_FILE = require('path').join(__dirname, '..', 'bot-data', 'instruments-cache.json');
  const inverseSyms = new Set(); // inverse/short ETPs — they RISE when the market falls
  function adoptUniverse(universe, label) {
    if (!Array.isArray(universe) || universe.length <= bus.universe.length) return false;
    bus.universe = universe;
    inverseSyms.clear();
    for (const u of universe) {
      t212Ticker[u.y] = u.t212;
      if (u.gbx) gbxTickers.add(u.t212);
      if (/(-[123]x|\b[123]x short|short daily|inverse|\bbear\b)/i.test(u.name || '')) inverseSyms.add(u.y);
    }
    bus.t212Status.mapped = Object.keys(t212Ticker).length;
    console.log(`[t212] universe loaded from ${label}: ${universe.length} instruments (${inverseSyms.size} inverse ETPs flagged for the bear lane)`);
    return true;
  }
  function loadFromCache() {
    if (bus.universe.length > 1000) return; // already expanded
    const fs = require('fs');
    // 1) volume cache (freshest, survives restarts when the volume is healthy)
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (Array.isArray(raw) && adoptUniverse(fromInstruments(raw).universe, 'VOLUME CACHE')) return;
      }
    } catch (e) { console.log('[t212] volume cache load failed: ' + e.message); }
    // 2) BUNDLED SNAPSHOT — ships inside the repo/image, so even a brand-new container
    // with an empty volume boots with the FULL universe instantly instead of showing the
    // 244-name fallback for minutes (the "universe is 244" incident). Live refresh follows.
    try {
      const snapPath = require('path').join(__dirname, '..', 'data', 'universe-snapshot.json');
      if (fs.existsSync(snapPath)) adoptUniverse(JSON.parse(fs.readFileSync(snapPath, 'utf8')), 'BUNDLED SNAPSHOT');
    } catch (e) { console.log('[t212] snapshot load failed: ' + e.message); }
  }
  async function expandUniverse() {
    // always attempt periodic refresh — don't skip based on prior universe size, since mappings can stale/change
    try {
      const inst = await t212.instruments();
      if (inst.status === 200 && Array.isArray(inst.body)) {
        const { universe, skipped } = fromInstruments(inst.body);
        // only update if we have new/changed data
        if (universe.length > 0 && universe.length !== bus.universe.length) {
          bus.universe = [];   // force adoptUniverse to accept the refresh
          for (const k of Object.keys(t212Ticker)) delete t212Ticker[k];  // clear in place — t212Ticker is const
          gbxTickers.clear();
          adoptUniverse(universe, `LIVE REFRESH (${skipped} unmappable skipped)`);
          // refresh the on-disk cache
          try { require('fs').writeFileSync(CACHE_FILE, JSON.stringify(inst.body)); } catch (e) {}
        }
      } else {
        console.log('[t212] instruments fetch HTTP ' + inst.status + ' — cache in use, will retry');
      }
    } catch (e) { console.log('[t212] instruments fetch failed — cache in use, will retry: ' + e.message); }
  }
  loadFromCache();   // instant 16k universe from disk — no API dependency
  tryConnect();
  setInterval(() => { if (!t212.connected()) tryConnect(); }, AUTH_RETRY_MS);
  setInterval(() => { if (t212.connected()) expandUniverse(); }, 3 * 60e3); // keep retrying until the 16k universe lands

  // /equity/account/cash rate-limits far more aggressively than the rest of the API
  // (observed: hours-long 429 on /cash while summary/portfolio/orders all return 200).
  // /equity/account/summary carries the same balance data, so fall back to it whenever
  // /cash is throttled or errors — the dashboard equity must never go stale over this.
  async function fetchCash() {
    try {
      const c = await t212.cash();
      if (c.status === 200) {
        bus.t212Status.cash = c.body.free != null ? c.body.free : c.body.total;
        bus.t212Status.total = c.body.total;
        return true;
      }
    } catch (e) {}
    try {
      const s = await t212.summary();
      if (s.status === 200 && s.body && s.body.cash) {
        bus.t212Status.cash = s.body.cash.availableToTrade;
        bus.t212Status.total = s.body.totalValue;
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function reconcile() {
    if (!t212.connected()) return;
    // paper positions are meaningless (and visually confusing) while the real account is
    // live — purge any that leaked in through the boot window and reset the toy balance
    if (Object.keys(state.paper.positions).length) {
      console.log(`[trader] purging ${Object.keys(state.paper.positions).length} paper position(s) — T212 is connected, the virtual ledger is retired`);
      state.paper.positions = {};
      state.paper.balance = 10000;
      bus.markDirty();
    }
    // cash and portfolio are independent try/catches — a network abort on one (common
    // against T212's demo API) must never skip the other, especially the portfolio-based
    // phantom-position cleanup below.
    try { await fetchCash(); } catch (e) {}
    try {
      const p = await t212.portfolio();
      if (p.status === 200 && Array.isArray(p.body)) {
        if (bus.recordTrade) bus.recordTrade();  // reconcile succeeded; bot is alive
        // the dead-man switch paused us during an API outage — the API answers again,
        // so trading resumes hands-free (a manual dashboard pause is left alone)
        if (state.pause && state.pausedBy === 'deadman') {
          state.pause = false; delete state.pausedBy;
          console.log('[t212] API healthy again — auto-resuming after dead-man pause');
          if (bus.notify) bus.notify('✅ T212 API recovered — trading auto-resumed.');
          bus.markDirty();
        }
        const seen = new Set();
        const rev = {};
        for (const [y, t] of Object.entries(t212Ticker)) rev[t] = y;
        for (const pos of p.body) {
          seen.add(pos.ticker);
          // T212 reports averagePrice in the instrument's own currency — GBX PENCE for
          // most .L names — while our market prices are normalized pounds. ÷100 or every
          // gain/stop calculation on a London position is off by 100x.
          const avgPx = gbxTickers.has(pos.ticker) ? pos.averagePrice / 100 : pos.averagePrice;
          // T212 reports the TRUE first-fill time — use it so hold-time clocks (hygiene,
          // recycler, min-hold) survive reboots instead of resetting on every deploy,
          // which froze all time-based exits on days with several restarts.
          const trueOpenedAt = pos.initialFillDate ? new Date(pos.initialFillDate).getTime() : null;
          const local = Object.values(state.t212.positions).find(x => x.t212Ticker === pos.ticker);
          if (local) {
            local.qty = pos.quantity;  // sync with real fill
            local.entry = avgPx;
            if (trueOpenedAt && (!local.openedAt || local.openedAt > trueOpenedAt)) local.openedAt = trueOpenedAt;
            local.pendingFill = false;  // fill is now confirmed, safe to exit
            continue;
          }
          // position exists on T212 but not locally (fresh cloud run / lost state) — adopt it so exits keep working
          const sym = rev[pos.ticker];
          if (sym) {
            state.t212.positions[sym] = { t212Ticker: pos.ticker, entry: avgPx, qty: pos.quantity,
              invested: +(avgPx * pos.quantity).toFixed(2), opened: 'recovered', openedAt: trueOpenedAt || Date.now(), peak: avgPx,
              conf: 0, sigType: 'adopted', reason: 'recovered from T212 account after restart' };
            console.log('[t212] adopted existing position ' + pos.ticker);
          }
        }
        for (const [sym, pos] of Object.entries(state.t212.positions)) {
          if (!seen.has(pos.t212Ticker) && !pos.pendingFill) { delete state.t212.positions[sym]; continue; }
          // STALE PENDING-FILL SWEEP: a position awaiting fill confirmation for over 3 min
          // and absent from the real T212 portfolio is a phantom (order threw/aborted before
          // this reconcile could confirm it) — purge it so it can't block the symbol forever.
          if (pos.pendingFill && !seen.has(pos.t212Ticker) && pos.openedAt && Date.now() - pos.openedAt > 3 * 60e3) {
            console.log(`[t212] purging stale phantom position ${sym} (pendingFill >3min, not on T212)`);
            delete state.t212.positions[sym];
          }
        }
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
    if (state.blacklist && state.blacklist[sym]) { mk.lastConf = 0; mk.lastWhy = 'blacklisted from dashboard'; return; }
    const senti = sentiFor(sym);
    // ——— NEWS COMPOSITE — raw headline sentiment + news-brain interpretation + the
    // headline→stock correlator, fused into ONE score. THE LOUDEST VOICE IN THE ROOM:
    // it can originate a trade on its own, it carries the biggest confidence weight,
    // and strongly negative news vetoes any entry regardless of the chart.
    const nbSig = (bus.newsBridge && bus.newsBridge.signal && bus.newsBridge.signal[sym]) || 0;
    const niSig = (bus.newsImpact && bus.newsImpact[sym]) || 0;
    const newsScore = Math.max(-1, Math.min(1, senti * 0.4 + nbSig * 0.5 + niSig * 0.6));
    let ev = evaluate(mk, senti, bus.news.fng ? bus.news.fng.value : null, 1);
    // NEWS-DRIVEN ENTRY: strong positive news IS a thesis — no technical setup required.
    // Gate 0.35 (not 0.45 — the composite is a product of three sub-1 signals, 0.45 was
    // nearly unreachable) and flat-tolerant (a name digesting news sideways still qualifies;
    // only an actively falling tape disqualifies).
    if (!ev && newsScore >= 0.35 && mk.price != null && mk.rsi != null && mk.rsi < 72) {
      const clsN = mk.closes || [];
      const notFalling = clsN.length >= 2 && clsN[clsN.length - 1] >= clsN[clsN.length - 2] * 0.999;
      if (notFalling) ev = { conf: Math.min(0.78, 0.5 + newsScore * 0.35), sigType: 'NEWS',
        reasons: [`📰 news-driven — composite +${newsScore.toFixed(2)} (senti ${senti.toFixed(2)} · brain ${nbSig.toFixed(2)} · correlator ${niSig.toFixed(2)})`] };
    }
    if (!ev) { mk.lastConf = 0; mk.lastWhy = mk.rsi != null ? `no buy setup — RSI ${mk.rsi.toFixed(1)}${mk.rsi > 68 ? ' overbought' : ''}` : 'warming up'; return; }
    // 🐻 BEAR LANE — inverse ETPs profit from falling markets, so every market-direction
    // rule inverts for them: bad market news is their tailwind (no news veto), and the
    // index being weak is their setup. This gives a long-only account red-day offense.
    const isInverse = inverseSyms.has(sym);
    // NEWS VETO — clearly negative news kills the entry, whatever the chart says.
    // (skipped for inverse ETPs — a red tape is exactly when they work)
    if (!isInverse && newsScore <= -0.30) { mk.lastConf = 0; mk.lastWhy = `⛔ news veto (${newsScore.toFixed(2)}) — not buying into bad news`; return; }
    // DATA-HEALTH GATE — when the sentinel says the price APIs are failing, entering is
    // trading blind; hold fire until the data source recovers.
    if (bus.sentinelStatus && bus.sentinelStatus.apiHealthy === false) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ data source unhealthy'; return; }
    // STALE-QUOTE GUARD — the full scan pass takes ~40 min; entering on a price that old
    // is trading blind. Only fresh quotes (≤2 min) may trade; hot-lane names (holdings,
    // news, TV, movers) refresh every few seconds so real opportunities stay eligible.
    if (!mk.lastTickAt || Date.now() - mk.lastTickAt > 120e3) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ quote stale — waiting for fresh scan'; return; }
    // RE-ENTRY COOLDOWN — 20 min after closing a name before buying it again (a brand-new
    // volume spike overrides). Stops the same-symbol churn that just pays the spread twice.
    state.lastClosed = state.lastClosed || {};
    if (state.lastClosed[sym] && Date.now() - state.lastClosed[sym] < 20 * 60e3 && !(mk.volSurge >= 1.8)) {
      mk.lastConf = 0; mk.lastWhy = '⏸ just traded this — 20m cooldown'; return;
    }
    // AUTO DAY-BLACKLIST — two losing trades in one symbol today means the read is wrong
    // there; stop donating spread to it until tomorrow.
    if (state.autoBlack && state.autoBlack[sym] === new Date().toDateString()) {
      mk.lastConf = 0; mk.lastWhy = '⛔ 2 losses here today — benched until tomorrow'; return;
    }
    // US MICRO-CAP JUNK FILTER — sub-$2 names churn on spread alone.
    if (venue(sym) === 'US' && mk.price < 2) { mk.lastConf = 0; mk.lastWhy = '⛔ sub-$2 micro-cap — spread junk'; return; }
    const lm = learnMul(ev.sigType, sym);
    let conf = Math.max(0, Math.min(1, ev.conf * lm));
    let tvNote = '';
    const tvr = bus.tvRatings && bus.tvRatings[sym];
    if (tvr && Date.now() - tvr.at < 30 * 60e3) {
      // TV VETO — a fresh SELL-side rating from 122 indicators blocks the entry outright.
      if (tvr.rec <= -0.35) { mk.lastConf = 0; mk.lastWhy = `⛔ TradingView veto — ${tvr.label} (${tvr.rec.toFixed(2)})`; return; }
      conf = Math.max(0, Math.min(1, conf + tvr.rec * 0.28));   // TV: main decision factor
      tvNote = ` · TradingView says ${tvr.label} (${tvr.rec.toFixed(2)})${tvr.detail ? ': ' + tvr.detail : ''}`;
    }
    // NEWS: the single biggest confidence weight in the whole assembly (±0.30).
    // Inverse ETPs read it MIRRORED — grim market news is their fuel.
    if (newsScore !== 0) { const nsDir = isInverse ? -newsScore : newsScore; conf = Math.max(0, Math.min(1, conf + nsDir * 0.30)); tvNote += ` · 📰 news ${(newsScore > 0 ? '+' : '') + newsScore.toFixed(2)}${isInverse ? ' (mirrored — inverse ETP)' : ''}`; }
    // ⚡ SPIKE SCALP — a sharp pop on real volume is its own thesis: ride it, bank it fast.
    // 1-min bars: ≥1.8% move over the last 15 bars, on ≥1.8× normal volume, still rising.
    const cl = mk.closes || [];
    const base15 = cl.length >= 16 ? cl[cl.length - 16] : null;
    const spikePct = base15 ? (mk.price - base15) / base15 : 0;
    const stillRising = cl.length >= 2 && cl[cl.length - 1] >= cl[cl.length - 2];
    const tune = (state.coach && state.coach.tuned) || {};   // 🎓 coach-tuned parameters (hard-bounded)
    if (spikePct >= 0.018 && (mk.volSurge || 0) >= (tune.spikeVol || 1.8) && stillRising) {
      ev.sigType = 'SPIKE';
      conf = Math.min(1, conf + 0.25);
      tvNote += ` · ⚡ SPIKE +${(spikePct * 100).toFixed(1)}% in 15m on ${(mk.volSurge).toFixed(1)}× volume`;
    }
    // 🔔 OPENING-RANGE BREAKOUT — classic intraday momentum edge: price clearing the
    // first-15-minute high on volume, early in the session (closes[] holds only today's
    // 1-min bars, so bar count ≈ minutes since the open).
    else if (cl.length >= 20 && cl.length <= 60 && stillRising && (mk.volSurge || 0) >= 1.5) {
      const orHigh = Math.max(...cl.slice(0, 15));
      if (mk.price > orHigh * 1.002) {
        ev.sigType = 'ORB';
        conf = Math.min(1, conf + 0.18);
        tvNote += ` · 🔔 opening-range breakout (>15m high on ${(mk.volSurge).toFixed(1)}× vol)`;
      }
    }
    // 🚀 GAP-AND-GO — opened ≥2.5% above yesterday's close WITH positive news behind it
    // and volume confirming: the gap is the market repricing the story; ride the go.
    // EARNINGS-DAY EXCEPTION (post-earnings-drift evidence): a stock gapping ≥4% on its
    // own report day keeps drifting — the lane stays open all session, not just the open.
    const reportedToday = bus.earningsInDays && bus.earningsInDays(sym) === 0;
    if (ev.sigType !== 'SPIKE' && ev.sigType !== 'ORB' &&
        (cl.length <= 45 || (reportedToday && (mk.pct24h || 0) >= 4)) &&
        (mk.pct24h || 0) >= 2.5 && newsScore > 0.1 && (mk.volSurge || 0) >= 1.5 && stillRising) {
      ev.sigType = 'GAP';
      conf = Math.min(1, conf + (reportedToday ? 0.24 : 0.20));
      tvNote += ` · 🚀 gap-and-go +${(mk.pct24h).toFixed(1)}%${reportedToday ? ' (earnings day — drift lane)' : ''} on news ${(newsScore > 0 ? '+' : '') + newsScore.toFixed(2)}`;
    }
    // 🏁 CLOSE-RUN — documented last-hour momentum: above VWAP, green on the day, still
    // rising inside the final hour → tends to keep running into the bell.
    const m2cEarly = minsToClose(sym);
    if (!/^(SPIKE|ORB|GAP)$/.test(ev.sigType || '') && m2cEarly != null && m2cEarly <= 60 && m2cEarly > 8 &&
        mk.vwap && mk.price > mk.vwap && (mk.pct24h || 0) > 0.3 && stillRising) {
      ev.sigType = 'CLOSE_RUN';
      conf = Math.min(1, conf + 0.15);
      tvNote += ` · 🏁 close-run (last hour, above VWAP, +${(mk.pct24h).toFixed(1)}% day)`;
    }
    // POWER-HOURS BOOST — intraday momentum concentrates in the first 30 min and the
    // last hour of the session (midday already gets docked separately).
    if (cl.length <= 30 || (m2cEarly != null && m2cEarly <= 60)) conf = Math.min(1, conf * 1.06);
    // OPENING-SPREAD GUARD — the first minutes print the widest spreads of the session;
    // only the gap lane (built for the open, needs news backing) is allowed to pay them.
    if (cl.length <= 5 && ev.sigType !== 'GAP') { mk.lastConf = 0; mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ first minutes — spreads at their widest'; return; }
    // MARKET-TAPE GATE — a US long fights the whole tape when SPY is under its session
    // VWAP; when the index is above it, longs get a small tailwind. MIRRORED for inverse
    // ETPs: a weak index is their green light.
    if (venue(sym) === 'US' || isInverse) {
      const spy = bus.market['SPY'];
      if (spy && spy.lastTickAt && Date.now() - spy.lastTickAt < 10 * 60e3 && spy.vwap && spy.price) {
        const tapeDown = spy.price < spy.vwap;
        if (isInverse) { if (tapeDown) { conf = Math.min(1, conf * 1.08); tvNote += ' · 🐻 tape falling — inverse tailwind'; } else conf *= 0.85; }
        else if (tapeDown) { conf *= 0.88; tvNote += ' · SPY under VWAP (tape against longs)'; }
        else conf = Math.min(1, conf * 1.03);
      }
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

    // ——— CONSENSUS VOTES (#1/#6fix) — which independent agents back this entry ———
    // #6fix: signal vote is now optional (enable if feature flag, or always for practice)
    const votes = [];
    const useSignalVote = prof.name === 'practice' || (process.env.CONSENSUS_REQUIRE_SIGNAL !== 'false');
    if (useSignalVote) votes.push('signal');
    if (tvr && Date.now() - tvr.at < 30 * 60e3 && tvr.rec > 0.15) votes.push('tv');
    if (lt && Date.now() - lt.at < 25 * 3600e3 && lt.regime > 0) votes.push('historian');
    if (bus.rankTop && bus.rankTop.has(sym)) votes.push('ranker');
    if (bus.pine && bus.pine[sym] && bus.pine[sym].net >= 2) votes.push('pine');
    if (senti > 0.2) votes.push('news');
    if (bus.news.congressBoost && bus.news.congressBoost[sym.split('.')[0]] > 0) votes.push('congress');
    if ((mk.volSurge || 0) > 1.8) votes.push('volume');
    // NEWS BRAIN + NEWS CORRELATOR votes — their confidence weight now flows through the
    // fused newsScore above (±0.30, the biggest single factor); here they only add their
    // independent consensus votes so the vote count reflects who backs the entry.
    if (bus.newsBridge && bus.newsBridge.vote && bus.newsBridge.vote(sym)) { votes.push('newsbrain'); tvNote += ` · news-brain +${nbSig.toFixed(2)}`; }
    if (niSig > 0.3) { votes.push('news-correlate'); tvNote += ` · news→stock +${niSig.toFixed(2)}`; }
    // INSTITUTIONAL DESKS (agents 🏦): Goldman-screener quality + McKinsey macro sector
    // tilt, bounded advisory fold-in — more information, never a constraint.
    if (bus.desks) {
      const sq = bus.desks.screener && bus.desks.screener.scores && bus.desks.screener.scores[sym];
      if (sq != null) {
        conf = Math.max(0, Math.min(1, conf + (sq - 0.5) * 0.10));
        if (sq > 0.75) { votes.push('desk-screener'); tvNote += ` · screener quality ${(sq * 100).toFixed(0)}%`; }
      }
      const mt = bus.desks.macro && bus.desks.macro.sectorTilt && bus.desks.macro.sectorTilt[require('../lib/fleet').sectorOf(sym)];
      if (mt != null && Math.abs(mt) > 0.2) {
        conf = Math.max(0, Math.min(1, conf + mt * 0.05));
        if (mt > 0.35) votes.push('desk-macro');
        tvNote += ` · macro ${mt > 0 ? 'tailwind' : 'headwind'} ${mt}`;
      }
    }
    // TRUMP desk + QUIVER (congress/gov-contracts) — bounded advisory, never a blind follow
    const tsig = (bus.trumpSignal && bus.trumpSignal[sym]) || 0;
    if (Math.abs(tsig) > 0.25) {
      conf = Math.max(0, Math.min(1, conf + tsig * 0.06));
      if (tsig > 0.4) { votes.push('trump-desk'); tvNote += ` · Trump-linked +${tsig.toFixed(2)}`; }
      else if (tsig < -0.4) tvNote += ` · Trump headwind ${tsig.toFixed(2)}`;
    }
    const qsig = (bus.quiverSignal && bus.quiverSignal[sym]) || 0;
    if (Math.abs(qsig) > 0.2) {
      conf = Math.max(0, Math.min(1, conf + qsig * 0.05));
      if (qsig > 0.35) { votes.push('quiver'); tvNote += ` · congress/gov buying +${qsig.toFixed(2)}`; }
    }
    // 🌊 SECTOR FLOW — leaders in today's hot sectors get a boost + vote; laggards in
    // cold sectors get docked. Ride the money flow, don't fight it.
    const flowSig = (bus.flowSignal && bus.flowSignal[sym]) || 0;
    if (flowSig > 0.2) { conf = Math.min(1, conf + Math.min(0.08, flowSig * 0.08)); votes.push('flow'); tvNote += ` · 🌊 sector leader +${flowSig.toFixed(2)}`; }
    else if (flowSig < 0) { conf = Math.max(0, conf + flowSig * 0.15); tvNote += ' · 🌊 cold-sector laggard'; }
    // EIGHT COMMODITY DESKS — bounded advisory on the mapped commodity ETCs
    const cd = (bus.commodDeskSignal && bus.commodDeskSignal[sym]) || null;
    if (cd && Math.abs(cd.score) > 0.04) {
      conf = Math.max(0, Math.min(1, conf + cd.score * 0.6));
      if (cd.score > 0.05) { votes.push('commodity-desk'); tvNote += ` · ${String(cd.why).slice(0, 40)} +${cd.score.toFixed(2)}`; }
      else if (cd.score < -0.05) tvNote += ` · commodity desk bearish ${cd.score.toFixed(2)}`;
    }
    mk.lastVotes = votes;

    // BACKER-QUALITY DOCK — the perf scorecard knows which agents' votes have actually
    // preceded winners. If EVERY backer of this entry is a historically money-losing
    // voice (≥8 closed trades, net negative), demand more edge before following them.
    if (votes.length && bus.perf && Array.isArray(bus.perf.byAgent) && bus.perf.byAgent.length) {
      const losing = new Set(bus.perf.byAgent.filter(a => (a.wins + a.losses) >= 8 && a.pnl < 0).map(a => a.agent));
      if (losing.size && votes.every(v => losing.has(v))) { conf *= 0.9; tvNote += ' · ⏸ backers historically losing'; }
    }

    // ——— BULLSHIT-COMPANY FILTER — a pure technical blip on a name with ZERO news, ZERO
    // TradingView backing and ZERO desk interest is how junk enters the book. Spikes are
    // exempt (volume-confirmed momentum is its own thesis); everything else gets docked
    // hard enough that only genuinely strong setups clear the bar alone.
    const corroborated = votes.some(v => v !== 'signal' && v !== 'volume');
    const momentumThesis = /^(SPIKE|ORB|GAP)$/.test(ev.sigType || '');   // volume-confirmed momentum is its own thesis
    if (!corroborated && !momentumThesis) { conf *= 0.8; tvNote += ' · ⏸ no news/TV/desk backing'; }

    // ——— ENTRY TIMING (#8) — don't catch a falling knife on reversal setups ———
    const reversalSig = /RSI_OVERSOLD|RSI_DIP|DIP_REVERSAL|BB_BOUNCE/.test(ev.sigType || '');
    const turningUp = cl && cl.length >= 2 && cl[cl.length - 1] >= cl[cl.length - 2];
    if (reversalSig && !turningUp) conf *= 0.85;   // softened: no longer hard-blocks on 'real' profile
    // BELOW-VWAP DOCK — longs below the session VWAP fight the intraday tape; reversal
    // setups and volume spikes are exempt (buying below VWAP is their whole point).
    if (!reversalSig && !momentumThesis && mk.vwap && mk.price < mk.vwap) { conf *= 0.88; tvNote += ' · below VWAP'; }
    // MIDDAY-CHOP DOCK — the 2-4 hours before the close-run are the lowest-signal stretch
    // of the session; demand a touch more edge there.
    const m2c = minsToClose(sym);
    if (m2c != null && m2c > 160 && m2c < 260) { conf *= 0.93; tvNote += ' · midday chop'; }
    // SOFT TILT THROTTLE — five signal-trades in a row summing negative = the read is off;
    // demand +0.05 more conf until the tape proves otherwise. Lighter than perf cool-off.
    const recent5 = state.history.filter(h => h.action === 'SELL' && h.pnl != null && !/dead money|LIQUIDATED/i.test(h.why || '')).slice(0, 5);
    const tilting = recent5.length === 5 && recent5.reduce((a, h) => a + h.pnl, 0) < 0;

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

    // #new⑥: ANTI-CORRELATION BONUS — if new candidate is negatively correlated with holdings,
    // boost confidence (actively reward hedging). Don't apply if we have no holdings.
    const heldPositions = Object.keys(state.t212.positions);
    if (heldPositions.length > 0 && mk.closes) {
      for (const heldSym of heldPositions) {
        const hc = bus.market[heldSym] && bus.market[heldSym].closes;
        if (hc) {
          const corr = returnsCorr(mk.closes, hc);
          if (corr < -0.5) {
            conf = Math.min(1, conf + 0.1);   // boost by 0.1 (capped at 1.0)
            tvNote += ` · hedges ${heldSym} (corr ${corr.toFixed(2)})`;
            break;   // only one boost per entry, even if it hedges multiple
          }
        }
      }
    }

    conf = Math.max(0, Math.min(1, conf));
    mk.lastConf = +conf.toFixed(2);
    mk.lastWhy = ev.reasons.join(' · ') + (lm !== 1 ? ` · learning ×${lm.toFixed(2)}` : '') + tvNote + (prof.name === 'real' ? ' · [real profile]' : '');
    // EVERY instrument on T212 is exchange-listed (crypto ETPs & commodity ETCs trade on
    // LSE/Xetra too) — so NOTHING trades on a closed venue. One rule for all: venue must be
    // open by the clock. This is the hard guarantee against the holiday-order trap.
    const minConf = prof.minConf + (recovering ? 0.10 : 0) + (tilting ? 0.05 : 0);   // recovery/tilt demand a bigger edge
    if (state.pause || conf < minConf || !marketOpen(sym) || openCount() >= prof.maxOpen) return;
    if (votes.length < (prof.consensusMin || 1)) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ only ${votes.length} agent vote${votes.length === 1 ? '' : 's'} (need ${prof.consensusMin})`; return; }
    if (bus.perfBlocked && bus.perfBlocked()) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ performance cool-off'; return; }
    if (bus.riskGate && !bus.riskGate.canEnter()) return; // RISK GUARDIAN gate
    // LIQUIDITY GATE — venue-aware: the US tape is so deep that 5k/min still admits
    // micro-cap junk; demand 20k/min there. Other venues keep the profile floor.
    const liqFloor = venue(sym) === 'US' ? Math.max(20000, prof.minNotionalPerMin || 0) : prof.minNotionalPerMin;
    if (liqFloor && (mk.notionalPerMin == null || mk.notionalPerMin < liqFloor)) {
      mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ too illiquid to trade cleanly';
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
      // #5fix: now applies to both profiles (practice can test earnings risk)
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
    }
    // SECTOR / COUNTRY DIVERSIFICATION CAP — applies to EVERY profile now (it used to be
    // real-only, which let max-variance mode stack 20 correlated bets: that isn't extra
    // opportunity, it's the same bet many times while paying the spread on each).
    const held = Object.keys(state.t212.positions);
    if (held.length >= 2) {
      const afterN = held.length + 1;
      const sec = sectorOf(sym), cty = countryOf(sym);
      const sectorCap = prof.sectorCap != null ? prof.sectorCap : 1.0;
      const countryCap = prof.countryCap != null ? prof.countryCap : 1.0;
      if (sec !== 'index' && sec !== 'other') {
        const sameSec = held.filter(h => sectorOf(h) === sec).length + 1;
        if (sameSec / afterN > sectorCap) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ ${sec} already ${Math.round(sameSec / afterN * 100)}% of book`; return; }
      }
      const sameCty = held.filter(h => countryOf(h) === cty).length + 1;
      if (sameCty / afterN > countryCap) { mk.lastWhy = (mk.lastWhy || '') + ` · ⏸ ${cty} already ${Math.round(sameCty / afterN * 100)}% of book`; return; }
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
      // POWDER FLOOR — never deploy the last 15% of the account. Yesterday 18 positions
      // ate 98% of cash and the bot sat PARALYZED, unable to take a single fresh signal.
      // Cash on hand IS the ability to catch the next spike.
      const eqNow = (bus.t212Status.total && isFinite(bus.t212Status.total)) ? bus.t212Status.total : 100;
      if (cash < eqNow * 0.15) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ keeping 15% powder for the next spike'; return; }
      // DEAD-LETTER COOLDOWN — 2+ rejected orders on a ticker in the past hour means the
      // venue/instrument is rejecting us; stop feeding the order queue with retries.
      const dlCount = (bus.deadLetter || []).filter(d => d.sym === sym && Date.now() - (d.at || 0) < 3600e3).length;
      if (dlCount >= 2) { mk.lastWhy = (mk.lastWhy || '') + ' · ⏸ orders rejected twice this hour'; return; }
      // #new②: VOLATILITY-ADJUSTED SIZING — scale position size inverse to realized vol
      let volMul = 1;
      if (prof.volAdjustedSizing && bus.regime && bus.regime.volRatio > 0) {
        // high vol (volRatio > 1.0) → smaller size; low vol (volRatio < 1.0) → normal/larger size
        volMul = Math.max(0.5, Math.min(1.2, 1 / (bus.regime.volRatio || 1)));   // capped between 0.5× and 1.2×
      }
      // EXPECTANCY-ADAPTIVE SIZING — size up only with a PROVEN rolling edge (profit
      // factor over ≥15 closed trades); shrink hard when the system is demonstrably cold.
      let pfMul = 1;
      if (bus.perf && bus.perf.closed >= 15 && bus.perf.profitFactor != null) {
        pfMul = bus.perf.profitFactor >= 1.5 ? 1.15 : bus.perf.profitFactor >= 1.2 ? 1.05 : bus.perf.profitFactor < 0.8 ? 0.75 : 1;
      }
      const sizeMul = (reg && reg.mult ? reg.mult.size : 1) * (recovering ? 0.5 : 1) * volMul * pfMul;   // regime + recovery + vol + expectancy
      const frac = Math.min(prof.perTradeCap, (prof.sizeBase + conf * prof.sizeSlope) * sizeMul);
      const reserve = Math.max(2, cash * 0.02);          // keep a small cash reserve for fees/slippage
      let invest = Math.min(cash * frac, cash - reserve);
      if (bus.riskGate) invest = bus.riskGate.capInvest(invest); // never > profile per-trade cap of equity
      // £8 minimum — a £2 position can never outrun its own spread; fewer, meaningful bets
      if (invest < Math.max(8, T212_MIN_ORDER)) return;
      const qty = +(invest / mk.price).toFixed(4);
      if (qty <= 0) return;
      state.t212.positions[sym] = { t212Ticker: t212Ticker[sym], entry: mk.price, intendedPrice: mk.price, qty, origQty: qty, invested: invest, opened: now(), openedAt: Date.now(), peak: mk.price, conf, sigType: ev.sigType, reason: mk.lastWhy, votes, variant: VARIANT, pendingFill: true };
      // RESERVE the cash NOW, before any await — orders are spaced ≥2.6s apart in the
      // t212 queue while ticks fire every 2.5s, so without this several entries all
      // size against the SAME balance and over-commit (the July-4th £9,996 incident)
      bus.t212Status.cash = Math.max(0, cash - invest);
      // EVERY entry uses a MARKETABLE LIMIT — priced a hair through the spread so it fills
      // immediately but can never pay more than +0.3% above the quote. Uncapped market
      // orders were leaking money on entry across 17k thin-to-thick names; capped fills
      // are strictly better on practice AND real. Falls back to market if the venue rejects.
      const useLimit = true;
      const limitPx = +(mk.price * 1.003).toFixed(mk.price > 50 ? 2 : mk.price > 1 ? 3 : 5);
      const send = (q) => useLimit ? t212.limitOrder(t212Ticker[sym], q, limitPx) : t212.marketOrder(t212Ticker[sym], q);
      // The whole send/retry sequence is wrapped: a network abort/timeout THROWS rather
      // than returning a status, and without this catch the optimistic position record
      // above would be orphaned forever (never filled, never reconciled, never retried —
      // a permanent phantom slot). Treat a throw exactly like a rejected order.
      let r;
      try {
        // T212 instruments differ in allowed quantity precision — retry coarser on 400
        r = await send(qty);
        for (const dp of [2, 1, 0]) {
          if (r.status !== 400 || !/precision/i.test(JSON.stringify(r.body))) break;
          const q2 = +(invest / mk.price).toFixed(dp);
          if (q2 <= 0) break;
          state.t212.positions[sym].qty = q2;
          r = await send(q2);
        }
        // limit rejected for a non-quantity reason (tick size etc.) → fall back to market so the signal still trades
        if (useLimit && r.status !== 200) r = await t212.marketOrder(t212Ticker[sym], state.t212.positions[sym].qty);
      } catch (e) {
        delete state.t212.positions[sym];
        bus.t212Status.cash = (bus.t212Status.cash || 0) + invest;   // release the reservation
        bus.t212Status.lastError = `order network error: ${e.message}`;
        (bus.deadLetter = bus.deadLetter || []).push({ sym, ticker: t212Ticker[sym], error: `network: ${e.message}`, t: now(), at: Date.now() });
        console.log('[t212] ' + bus.t212Status.lastError);
        return;
      }
      if (r.status === 200) {
        // Order accepted, but keep pendingFill=true until we verify the actual filled quantity via reconcile/orders check
        // This prevents exitCheck from firing a stop-loss in the window where qty is stale (partial fill scenario)
        bus.t212Status.orders++;
        pushHist({ t: now(), sym, ledger: 'T212-PRACTICE', action: 'BUY', price: mk.price, qty: state.t212.positions[sym].qty, pnl: null, votes, cond: { rsi: mk.rsi != null ? +mk.rsi.toFixed(1) : null, regime: reg ? reg.state : null, sector: sectorOf(sym), atrPct: mk.atrPct }, why: `${mk.lastWhy} — conf ${(conf*100).toFixed(0)}%, votes[${votes.join(',')}], ~${invest.toFixed(2)} → REAL order on practice account (check your T212 app)` });
        console.log(`[trade] T212 BUY ${t212Ticker[sym]} qty=${state.t212.positions[sym].qty} (awaiting fill confirmation)`);
        if (bus.recordTrade) bus.recordTrade();  // signal health heartbeat: bot is alive
        // pendingFill stays true; reconcile() will verify actual fill and update qty, then it's safe to trade
      } else {
        delete state.t212.positions[sym];
        bus.t212Status.cash = (bus.t212Status.cash || 0) + invest;   // release the reservation
        bus.t212Status.lastError = `order rejected HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`;
        // DEAD-LETTER (#12): hand the failed order to the auditor to surface + alert
        (bus.deadLetter = bus.deadLetter || []).push({ sym, ticker: t212Ticker[sym], error: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 100)}`, t: now(), at: Date.now() });
        console.log('[t212] ' + bus.t212Status.lastError);
      }
      return;
    }
    // internal virtual ledger — ONLY while T212 is disconnected. When connected, a symbol
    // missing from t212Ticker (boot window before the universe cache loads, or a genuinely
    // unmappable name) must NOT silently trade $10k of virtual money next to a £97 real
    // account — that painted giant phantom positions all over the dashboard.
    if (t212.connected()) return;
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
      // sellInFlight: a SELL is queued/awaiting T212 — re-evaluating the exit would fire
      // a duplicate sell (reconcile can clear pendingFill mid-flight, so it can't guard this)
      if (!p || p.pendingFill || p.sellInFlight) continue;
      // UNIT-MISMATCH GUARD: if entry and live price disagree by >5×, one of them is in
      // the wrong currency unit (GBX vs GBP adoption edge). Any exit math on it would book
      // phantom P&L or fire a false stop — skip and let reconcile resync the entry.
      if (p.entry && mk.price && (p.entry / mk.price > 5 || mk.price / p.entry > 5)) continue;
      if (p.forceClose) { closePos(sym, ledger, book, p, mk, 'manual close from dashboard'); continue; }
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
      // momentum read for exit decisions: is the last 1-min bar falling? two in a row?
      const cls = mk.closes || [];
      const oneRed = cls.length >= 2 && cls[cls.length - 1] < cls[cls.length - 2];
      const twoRed = cls.length >= 3 && oneRed && cls[cls.length - 2] < cls[cls.length - 3];
      // runners breathe (coach-tunable) — but past +3% the trail snaps tight to 0.3%:
      // a rare big win is exactly the one that must not be handed back
      const tuneX = (state.coach && state.coach.tuned) || {};
      const trailGap = peakGain > 0.03 ? 0.003 : (tuneX.trailGap || 0.005);
      const turnedDown = gain <= peakGain - trailGap || twoRed;
      // ⚡ momentum entries (SPIKE / opening-range breakout / gap-and-go / close-run) all
      // live by scalper rules: ride the momentum, bank the turn, cut fast, never linger.
      if (p.sigType === 'SPIKE' || p.sigType === 'ORB' || p.sigType === 'GAP' || p.sigType === 'CLOSE_RUN') {
        let sWhy = null;
        if (netGain >= 0.012 && turnedDown) sWhy = `⚡ rode to +${(netGain * 100).toFixed(2)}% net, momentum turned — banking`;
        else if (peakGain >= 0.008 && gain <= peakGain - 0.005) sWhy = `⚡ spike fading (peak +${(peakGain * 100).toFixed(1)}% → +${(gain * 100).toFixed(1)}%) — banking`;
        else if (gain <= -0.01) sWhy = `⚡ spike failed ${(gain * 100).toFixed(1)}% — cutting fast`;
        else if (heldMin > 25 && netGain < 0.004) sWhy = `⚡ spike stalled ${heldMin.toFixed(0)}m — freeing the slot`;
        if (sWhy) { closePos(sym, ledger, book, p, mk, sWhy); continue; }
      }
      // MOMENTUM-TRAIL BANK: past +1% net the winner is NOT capped — as long as it keeps
      // climbing we hold, and the moment it turns down (0.3% off the peak or two straight
      // red bars) the profit is banked and the cash rotates into the next mover.
      const qt = tuneX.quickTake || prof.quickTake;
      if (qt && matured && netGain >= qt && turnedDown) {
        closePos(sym, ledger, book, p, mk, `💰 rode past +${(qt * 100).toFixed(1)}% to +${(netGain * 100).toFixed(2)}% net, turned down — banking & rotating`);
        continue;
      }
      // DEAD-MONEY RECYCLER (practice/high-risk): a position flat for 2h+ is a blocked
      // slot — the whole point is rotating capital into whatever is MOVING right now.
      // requires a REAL openedAt — a missing timestamp defaulted heldMin to 999 and
      // insta-dumped every re-adopted position on boot (the 2026-07-09 churn incident)
      if (prof.name === 'practice' && p.openedAt && heldMin > 90 && Math.abs(gain) < 0.005) {
        closePos(sym, ledger, book, p, mk, `dead money — flat ${heldMin.toFixed(0)}m, recycling the slot`);
        continue;
      }
      // BOOK HYGIENE — positions that today's quality bar would never admit (sub-$2 US
      // micro-caps, names too thin to trade cleanly) don't get grandfathered: once they've
      // had 30 min and aren't meaningfully winning, free the cash for filtered entries.
      if (prof.name === 'practice' && ledger === 'T212-PRACTICE' && p.openedAt && heldMin > 30 && gain < 0.01) {
        const thin = mk.notionalPerMin != null && mk.notionalPerMin < (venue(sym) === 'US' ? 20000 : (prof.minNotionalPerMin || 0));
        const penny = venue(sym) === 'US' && mk.price < 2;
        if (thin || penny) { closePos(sym, ledger, book, p, mk, `book hygiene — below today's quality bar (${penny ? 'sub-$2' : 'too thin'})`); continue; }
      }
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
      const mtcReal = minsToClose(sym);   // #1fix: both profiles now check time to close
      const minProfitGate = prof.overnightMinProfit || 0.001;  // #2fix: min profit to hold overnight
      let why = null;
      // capital protection ALWAYS fires (stop loss / trailing / bad news) regardless of hold time;
      // discretionary profit-taking waits until matured AND net-of-fees positive.
      if (gain <= stop) why = stop > 0 ? `${mode}: locked +${(netGain*100).toFixed(2)}% net (peak +${(peakGain*100).toFixed(2)}%)` : `${mode} at ${(gain*100).toFixed(2)}%`;
      else if (edx != null && edx >= 0 && edx <= 1 && !prof.earningsSmart) why = `earnings in ${edx}d — going flat before the gap (${(netGain*100).toFixed(2)}% net)`;
      else if (ns <= -1.5 && gain > -0.02) why = `bad news flow (${ns}) — exiting at ${(netGain*100).toFixed(2)}% net`;
      // #new①: EARNINGS SMART-EXIT — close early if report is today/tomorrow (instead of waiting for the gap)
      else if (prof.earningsSmart && edx != null && edx >= 0 && edx <= 1) why = `earnings in ${edx}d — closing early to avoid the gap (${(netGain*100).toFixed(2)}% net)`;
      // OVERNIGHT HOLD DECISION (#20/#1fix/#2fix): near the close, only carry a green, non-earnings winner
      // in a trending tape (with its stop tightened); otherwise flatten to dodge the gap.
      // #1fix: both profiles can now test overnight holding (removed real-only gate)
      // #2fix: require min profit before holding (prof.overnightMinProfit)
      else if (mtcReal != null && mtcReal <= 12) {
        if (netGain <= minProfitGate) why = `flat before the close — not carrying a thin position overnight (${(netGain*100).toFixed(2)}% < ${(minProfitGate*100).toFixed(2)}%)`;
        else if (!(prof || {}).overnightHold) why = `banking +${(netGain*100).toFixed(2)}% net before the close`;
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
      if (p.sellInFlight) return;            // a sell for this position is already on the wire
      p.sellInFlight = true;                 // NOT pendingFill — reconcile clears that mid-flight
      let r;
      try { r = await t212.marketOrder(p.t212Ticker, -p.qty); }
      catch (e) { p.sellInFlight = false; bus.t212Status.lastError = `sell network error: ${e.message}`; return; }
      if (r.status !== 200) { p.sellInFlight = false; bus.t212Status.lastError = `sell rejected HTTP ${r.status}`; return; }
      bus.t212Status.orders++;
      if (bus.recordTrade) bus.recordTrade();  // successful sell; bot is alive
      delete book[sym];
      bus.t212Status.cash = (bus.t212Status.cash || 0) + p.qty * mk.price;  // approximate credit; reconcile trues up in ≤60s
      state.realizedT212 = (state.realizedT212 || 0) + pnl;   // real-ledger P&L only — risk baseline math must not see paper P&L
    } else {
      state.paper.balance += p.qty * mk.price;
      delete book[sym];
    }
    state.realized += pnl;
    learnRecord(p.sigType, sym, pnl);
    // re-entry cooldown stamp + auto day-blacklist bookkeeping (2 real losses → benched today)
    (state.lastClosed = state.lastClosed || {})[sym] = Date.now();
    if (pnl < -0.05) {
      const today = new Date().toDateString();
      state.dayLosses = state.dayLosses || {};
      const k = sym + '|' + today;
      state.dayLosses[k] = (state.dayLosses[k] || 0) + 1;
      if (state.dayLosses[k] >= 2) { (state.autoBlack = state.autoBlack || {})[sym] = today; console.log(`[trader] ${sym} benched for today — 2 losing trades`); }
    }
    // exit-quality telemetry: what the trade gained vs what it SHOWED at its peak —
    // the gap ("left on table") is the number that tunes exit rules honestly
    const gainPct = p.entry ? +(((mk.price - p.entry) / p.entry) * 100).toFixed(2) : null;
    const peakPct = p.entry && p.peak ? +(((p.peak - p.entry) / p.entry) * 100).toFixed(2) : null;
    pushHist({ t: now(), sym, ledger, action: 'SELL', price: mk.price, qty: p.qty, pnl: +pnl.toFixed(2), gainPct, peakPct, why });
    console.log(`[trade] ${ledger} SELL ${sym} pnl=${pnl.toFixed(2)}`);
    bus.markDirty();
  }
  // PARTIAL SELL for the profit ladder — sells `fraction` of the CURRENT qty, books that
  // slice's net P&L, keeps the rest running. Only used on the T212 book.
  async function scaleOut(sym, book, p, mk, fraction, why) {
    const q = +(p.qty * fraction).toFixed(4);
    if (q <= 0 || q >= p.qty) return;
    if (p.sellInFlight) return;              // never overlap with another sell on this position
    p.sellInFlight = true;
    let r;
    try { r = await t212.marketOrder(p.t212Ticker, -q); }
    catch (e) { p.sellInFlight = false; (bus.deadLetter = bus.deadLetter || []).push({ sym, error: `ladder sell network: ${e.message}`, t: now(), at: Date.now() }); return; }
    if (r.status !== 200) { p.sellInFlight = false; (bus.deadLetter = bus.deadLetter || []).push({ sym, error: `ladder sell HTTP ${r.status}`, t: now(), at: Date.now() }); return; }
    p.sellInFlight = false;
    bus.t212Status.orders++;
    const gross = (mk.price - p.entry) * q;
    const fee = frictionPct(sym, bus.profile, mk) * (p.entry * q);
    const pnl = gross - fee;
    p.qty = +(p.qty - q).toFixed(4);
    bus.t212Status.cash = (bus.t212Status.cash || 0) + q * mk.price;  // approximate credit; reconcile trues up
    state.realizedT212 = (state.realizedT212 || 0) + pnl;
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
      // pendingFill = never confirmed on T212; there is nothing to sell — a market
      // sell for it just errors and re-poisons the queue. Reconcile purges these.
      // sellInFlight = a sell is already on the wire; don't double it.
      if (p.pendingFill || p.sellInFlight) continue;
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
