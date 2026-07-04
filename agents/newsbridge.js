'use strict';
// AGENT: NEWS BRIDGE — the connective tissue. It wires the News Radar (collector) and
// the News Brain (interpreter) INTO the rest of the fleet's existing boards: the
// trader's confidence votes, the regime board, the congress/insider board, the
// commodity & crypto desks. Nothing the first two agents learn is wasted — the Bridge
// turns their per-symbol lean into a live, bounded signal every other agent can read.
//
// It exposes two things:
//   • bus.newsBridge.signal[sym]  — a bounded (−1..+1) conviction the trader folds in
//   • bus.newsBridge.vote(sym)    — a boolean "news backs this entry" for the consensus gate
// Both are advisory and bounded — news can nudge and can add a vote, but never override
// the risk guardian, the market-hours gate, or the fee/liquidity gates.
const { sectorOf } = require('../lib/fleet');

const BRIDGE_MS = 20000;

function start(bus) {
  bus.newsBridge = { signal: {}, aligned: [], conflicts: [], updated: null,
    vote: (sym) => {
      const s = bus.newsBridge.signal[sym];
      return s != null && s > 0.25;   // meaningful positive news lean = one consensus vote
    },
  };

  function link() {
    if (bus.beat) bus.beat('newsbridge');
    const brain = bus.newsBrain;
    if (!brain || !brain.bias) return;

    const signal = {};
    // 1) direct per-symbol lean from the brain
    for (const [k, v] of Object.entries(brain.bias)) {
      if (k.startsWith('sector:')) continue;
      signal[k] = v;
    }
    // 2) fold the sector tilt onto any live market symbol not already carrying a direct lean
    for (const sym of Object.keys(bus.market || {})) {
      const secLean = brain.bias['sector:' + sectorOf(sym)];
      if (secLean != null) signal[sym] = Math.max(-1, Math.min(1, (signal[sym] || 0) + secLean * 0.4));
    }
    // 3) cross-check against the regime board — in a SHOCK tape, damp news conviction
    //    (news is noisiest exactly when vol spikes); in a clean TREND, let it speak.
    const reg = bus.regime;
    const regMul = reg && reg.state === 'shock' ? 0.4 : reg && reg.state === 'chop' ? 0.7 : 1.0;
    for (const k of Object.keys(signal)) signal[k] = +(signal[k] * regMul).toFixed(2);

    bus.newsBridge.signal = signal;

    // 4) surface where news AGREES with what we hold (aligned) vs fights it (conflict) —
    //    the dashboard shows this so the picture is honest.
    const aligned = [], conflicts = [];
    for (const sym of Object.keys(bus.state.t212.positions || {})) {
      const s = signal[sym];
      if (s == null) continue;
      if (s > 0.2) aligned.push({ sym, s });
      else if (s < -0.2) conflicts.push({ sym, s });
    }
    bus.newsBridge.aligned = aligned;
    bus.newsBridge.conflicts = conflicts;
    bus.newsBridge.updated = new Date().toLocaleTimeString();

    // 5) if the news brain turns HARD negative on something we hold, raise a flag the
    //    auditor/alerts can surface (advisory — never auto-sells on its own).
    for (const { sym, s } of conflicts) {
      if (s < -0.6 && bus.notify && !bus._newsWarned) {
        bus._newsWarned = {};
      }
      if (s < -0.6 && bus.notify && bus._newsWarned && !bus._newsWarned[sym]) {
        bus._newsWarned[sym] = Date.now();
        bus.notify(`📰 News brain turned strongly negative on a holding: ${sym} (${s}). Bot will manage via its normal exits.`);
      }
    }
  }

  setInterval(link, BRIDGE_MS);
  setTimeout(link, 22000);
  console.log('[newsbridge] news→fleet bridge armed — feeds interpreted news into trader votes, regime & holdings boards');
}
module.exports = { start };
