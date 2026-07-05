'use strict';
// AGENT ⑦: RISK GUARDIAN — the one agent with authority to stop everything.
// Hard rule: equity may never fall more than RISK.MAX_DRAWDOWN (10%) below its
// baseline. Below the floor: entries halt AND every position liquidates at market.
// Percentage-based → identical protection for £10,000 practice or £100 real
// (£100 account: the instant equity < £90, everything stops).
// Also: daily loss circuit-breaker, per-trade size cap, concentration warnings.
const { RISK, activeProfile } = require('../config');
const t212 = require('../lib/t212');

function start(bus) {
  const state = bus.state;
  bus.profile = activeProfile(null, t212.isLive());   // provisional until equity is known
  state.risk = state.risk || {};
  bus.riskStatus = {
    baseline: state.risk.baseline || null, floor: null, halted: !!state.risk.halted,
    haltReason: state.risk.haltReason || null, dayPaused: false, dayLoss: 0,
    perTradeCap: RISK.PER_TRADE_CAP, maxDrawdownPct: RISK.MAX_DRAWDOWN * 100,
    checked: null, incidents: state.risk.incidents || [],
  };

  function equityNow() {
    if (!bus.t212Status || !bus.t212Status.connected) return null;
    // T212's own "total" is authoritative — it includes free cash, cash blocked by
    // pending orders, and invested value. Free-cash+positions math gets poisoned
    // the moment an order queues (learned that twice today).
    if (bus.t212Status.total != null && isFinite(bus.t212Status.total) && bus.t212Status.total > 0)
      return bus.t212Status.total;
    let open = 0;
    for (const [s, p] of Object.entries(state.t212.positions)) {
      const px = bus.market[s]?.price;
      open += (px && isFinite(px) ? px : p.entry) * p.qty;
    }
    return (bus.t212Status.cash || 0) + open;
  }

  function incident(msg) {
    const inc = { t: new Date().toISOString(), msg };
    bus.riskStatus.incidents.unshift(inc);
    bus.riskStatus.incidents = bus.riskStatus.incidents.slice(0, 30);
    state.risk.incidents = bus.riskStatus.incidents;
    console.log('[RISK] ' + msg);
    bus.markDirty();
  }

  let connectedAt = null;
  function check() {
    bus.riskStatus.checked = new Date().toLocaleTimeString();
    if (bus.beat) bus.beat('risk');
    const eq = equityNow();
    if (eq == null || !isFinite(eq) || eq <= 0) return;

    // select the active trading profile from live-ness + account size (every agent reads bus.profile)
    bus.profile = activeProfile(eq, t212.isLive());
    bus.riskStatus.profile = bus.profile.name;
    bus.riskStatus.live = t212.isLive();
    // warm-up: wait 2 min after connect so positions have reconciled before
    // locking the baseline — a half-loaded portfolio reads as a tiny account
    if (!state.risk.baseline) {
      if (!connectedAt) { connectedAt = Date.now(); return; }
      if (Date.now() - connectedAt < 120e3) return;
      state.risk.baseline = +eq.toFixed(2);
      state.risk.realizedAtBaseline = state.realized || 0;
      incident(`baseline set: ${eq.toFixed(2)} — hard floor ${(eq * (1 - RISK.MAX_DRAWDOWN)).toFixed(2)}`);
    }
    // ─── AUTO-BASELINE: keep the risk floor synced to the ACTUAL account, hands-free ───
    // No button, no clicking. The baseline tracks deposits, withdrawals and practice-account
    // resets by itself. Two position-safe detectors:
    //   (a) big-jump: equity differs from baseline by >3× (or <1/3). No trade this bot makes
    //       moves 3×, so it's certainly the account itself changing (reset/switch) → resync.
    //   (b) flat-drift: with NO open positions, equity should equal baseline + realised P&L
    //       booked since the baseline; any gap beyond tolerance is external cash → resync.
    // Open positions swing equity via unrealised P&L, so (b) is gated on being flat — that
    // is why a genuine drawdown on OPEN trades still halts correctly and is never masked.
    if (state.risk.baseline > 0 && eq != null && isFinite(eq)) {
      const openCount = Object.keys(state.t212.positions).length + Object.keys(state.paper.positions).length;
      const realizedNow = state.realized || 0;
      if (state.risk.realizedAtBaseline == null) state.risk.realizedAtBaseline = realizedNow;  // migrate old state
      const realizedSince = realizedNow - state.risk.realizedAtBaseline;
      const drift = eq - (state.risk.baseline + realizedSince);
      const ratio = eq / state.risk.baseline;
      const bigJump = ratio > 3 || ratio < 0.34;
      const flatExternal = openCount === 0 && Math.abs(drift) > Math.max(10, state.risk.baseline * 0.05);
      if (bigJump || flatExternal) {
        incident(`auto-baseline £${state.risk.baseline.toFixed(2)} → £${eq.toFixed(2)} (${bigJump ? 'account change/reset' : 'deposit/withdrawal'} detected — floor resynced hands-free)`);
        if (bus.notify) bus.notify(`💷 Account balance now £${eq.toFixed(2)} — risk floor auto-resynced, no action needed.`);
        state.risk.baseline = +eq.toFixed(2);
        state.risk.dayStart = +eq.toFixed(2);                 // fresh day-start on a balance change
        state.risk.realizedAtBaseline = realizedNow;
        if (state.risk.halted) { state.risk.halted = false; state.risk.haltReason = null; bus.riskStatus.halted = false; bus.riskStatus.haltReason = null; state.pause = false; }
        bus.riskStatus.dayProfitLock = false; bus.riskStatus.dayPaused = false;
        bus.markDirty();
      }
    }
    state.risk.lastRealizedSnapshot = state.realized || 0;

    const today = new Date().toDateString();
    if (state.risk.day !== today) { state.risk.day = today; state.risk.dayStart = eq; bus.riskStatus.dayPaused = false; bus.riskStatus.dayProfitLock = false; bus.markDirty(); }

    // DAILY PROFIT LOCK-IN — "take the money and go home". Once the day's gain hits the
    // profile target, stop opening NEW positions (existing winners still ride their
    // trailing stops) so a good day can't be given back on fresh bets.
    const dayGain = state.risk.dayStart ? (eq - state.risk.dayStart) / state.risk.dayStart : 0;
    bus.riskStatus.dayGain = +(dayGain * 100).toFixed(2);
    if (!bus.riskStatus.dayProfitLock && bus.profile.dailyProfitTarget && dayGain >= bus.profile.dailyProfitTarget) {
      bus.riskStatus.dayProfitLock = true;
      incident(`daily profit target hit +${(dayGain * 100).toFixed(1)}% — locked in, no new entries until tomorrow`);
    }

    const floor = state.risk.baseline * (1 - RISK.MAX_DRAWDOWN);
    const dayFloor = (state.risk.dayStart || eq) * (1 - (bus.profile.dailyMaxLoss || RISK.DAILY_MAX_LOSS));
    bus.riskStatus.baseline = +state.risk.baseline.toFixed(2);
    bus.riskStatus.floor = +floor.toFixed(2);
    bus.riskStatus.dayLoss = +Math.max(0, (state.risk.dayStart || eq) - eq).toFixed(2);
    bus.riskStatus.equity = +eq.toFixed(2);

    // DRAWDOWN RECOVERY MODE (#4): between the recovery trigger and the hard floor, the
    // trader trades smaller, pickier, tighter — a gentle brake BEFORE the full halt.
    const below = state.risk.baseline ? (state.risk.baseline - eq) / state.risk.baseline : 0;
    const recTrig = (bus.profile && bus.profile.recoveryTrigger) || 0.05;
    const wasRecovering = bus.riskStatus.recovery;
    bus.riskStatus.recovery = !bus.riskStatus.halted && below > recTrig && below < RISK.MAX_DRAWDOWN;
    if (bus.riskStatus.recovery && !wasRecovering) incident(`recovery mode ON — ${(below * 100).toFixed(1)}% below baseline; sizing/entries tightened`);
    if (!bus.riskStatus.recovery && wasRecovering) incident('recovery mode cleared — back near baseline');

    if (!bus.riskStatus.halted && eq < floor) {
      bus.riskStatus.halted = true;
      state.risk.halted = true;
      state.risk.haltReason = bus.riskStatus.haltReason =
        `equity ${eq.toFixed(2)} broke the ${(RISK.MAX_DRAWDOWN * 100).toFixed(0)}% floor (${floor.toFixed(2)}) — HALT + FULL LIQUIDATION`;
      state.pause = true;
      incident(bus.riskStatus.haltReason);
      if (bus.liquidateAll) bus.liquidateAll('RISK GUARDIAN: max drawdown floor breached');
    } else if (!bus.riskStatus.halted && !bus.riskStatus.dayPaused && eq < dayFloor) {
      bus.riskStatus.dayPaused = true;
      incident(`daily circuit breaker: -${((1 - eq / state.risk.dayStart) * 100).toFixed(1)}% today — no new entries until tomorrow`);
    }
    // concentration check: warn if one position > PER_TRADE_CAP of equity
    for (const [s, p] of Object.entries(state.t212.positions)) {
      const val = (bus.market[s]?.price || p.entry) * p.qty;
      if (val > eq * bus.profile.perTradeCap * 1.05 && !p._concWarned) {
        p._concWarned = true;
        incident(`concentration: ${s} is ${(val / eq * 100).toFixed(0)}% of equity`);
      }
    }
  }

  // trader consults these gates before every entry
  bus.riskGate = {
    canEnter: () => !bus.riskStatus.halted && !bus.riskStatus.dayPaused && !bus.riskStatus.dayProfitLock,
    capInvest: (invest) => {
      const eq = equityNow();
      const cap = (bus.profile && bus.profile.perTradeCap) || RISK.PER_TRADE_CAP;
      return eq ? Math.min(invest, eq * cap) : invest;
    },
  };

  setInterval(check, 5000);
  console.log(`[risk] GUARDIAN armed — max total loss ${(RISK.MAX_DRAWDOWN * 100).toFixed(0)}% of baseline, daily breaker ${(RISK.DAILY_MAX_LOSS * 100).toFixed(0)}%`);
}
module.exports = { start };
