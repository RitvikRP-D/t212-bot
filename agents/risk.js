'use strict';
// AGENT ⑦: RISK GUARDIAN — the one agent with authority to stop everything.
// Hard rule: equity may never fall more than RISK.MAX_DRAWDOWN (10%) below its
// baseline. Below the floor: entries halt AND every position liquidates at market.
// Percentage-based → identical protection for £10,000 practice or £100 real
// (£100 account: the instant equity < £90, everything stops).
// Also: daily loss circuit-breaker, per-trade size cap, concentration warnings.
const { RISK } = require('../config');

function start(bus) {
  const state = bus.state;
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
    const eq = equityNow();
    if (eq == null || !isFinite(eq) || eq <= 0) return;
    // warm-up: wait 2 min after connect so positions have reconciled before
    // locking the baseline — a half-loaded portfolio reads as a tiny account
    if (!state.risk.baseline) {
      if (!connectedAt) { connectedAt = Date.now(); return; }
      if (Date.now() - connectedAt < 120e3) return;
      state.risk.baseline = +eq.toFixed(2);
      incident(`baseline set: ${eq.toFixed(2)} — hard floor ${(eq * (1 - RISK.MAX_DRAWDOWN)).toFixed(2)}`);
    }
    const today = new Date().toDateString();
    if (state.risk.day !== today) { state.risk.day = today; state.risk.dayStart = eq; bus.riskStatus.dayPaused = false; bus.markDirty(); }

    const floor = state.risk.baseline * (1 - RISK.MAX_DRAWDOWN);
    const dayFloor = (state.risk.dayStart || eq) * (1 - RISK.DAILY_MAX_LOSS);
    bus.riskStatus.baseline = +state.risk.baseline.toFixed(2);
    bus.riskStatus.floor = +floor.toFixed(2);
    bus.riskStatus.dayLoss = +Math.max(0, (state.risk.dayStart || eq) - eq).toFixed(2);
    bus.riskStatus.equity = +eq.toFixed(2);

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
      if (val > eq * RISK.PER_TRADE_CAP * 1.05 && !p._concWarned) {
        p._concWarned = true;
        incident(`concentration: ${s} is ${(val / eq * 100).toFixed(0)}% of equity`);
      }
    }
  }

  // trader consults these gates before every entry
  bus.riskGate = {
    canEnter: () => !bus.riskStatus.halted && !bus.riskStatus.dayPaused,
    capInvest: (invest) => {
      const eq = equityNow();
      return eq ? Math.min(invest, eq * RISK.PER_TRADE_CAP) : invest;
    },
  };

  setInterval(check, 5000);
  console.log(`[risk] GUARDIAN armed — max total loss ${(RISK.MAX_DRAWDOWN * 100).toFixed(0)}% of baseline, daily breaker ${(RISK.DAILY_MAX_LOSS * 100).toFixed(0)}%`);
}
module.exports = { start };
