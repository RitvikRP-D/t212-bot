'use strict';
// AGENT ㊹: COACH — the self-improvement loop (video-inspired: eval → lesson → tune).
// Once per day after the US close it GRADES the day's closed trades, writes plain-
// language LESSONS into persistent memory, and makes SMALL, HARD-BOUNDED adjustments
// to the trading parameters — then the next session trades with the tuned values.
// Every adjustment is logged and visible; nothing can drift outside its bounds.
//   reads:  state.history (closed trades), bus.perf (win rate, PF, left-on-table)
//   writes: state.coach = { lessons: [...], tuned: { quickTake, spikeVol, trailGap } }
//   trader reads state.coach.tuned with hard clamps — the feedback loop closes.
const BOUNDS = {
  quickTake: [0.008, 0.02],   // momentum-trail arming threshold
  spikeVol:  [1.5, 2.6],      // volume surge needed to call a SPIKE
  trailGap:  [0.003, 0.008],  // how much a winner may pull back before banking
};
const clampB = (k, v) => Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], v));

function start(bus) {
  const state = bus.state;
  state.coach = state.coach || { lessons: [], tuned: {} };
  bus.coachStatus = { lessons: state.coach.lessons.length, lastRun: state.coach.lastRun || null, tuned: state.coach.tuned };

  function lesson(msg) {
    state.coach.lessons.unshift({ t: new Date().toISOString(), msg });
    state.coach.lessons = state.coach.lessons.slice(0, 60);
    console.log('[coach] ' + msg);
  }

  function evaluate() {
    if (bus.beat) bus.beat('coach');
    const ukHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()), 10);
    const today = new Date().toDateString();
    if (ukHour < 21 || state.coach.lastRun === today) return;   // one grading pass per day, after the close
    state.coach.lastRun = today;

    const t = state.coach.tuned;
    const P = bus.perf || {};
    const closed = (state.history || []).filter(h => h.action === 'SELL' && h.pnl != null && !/dead money|LIQUIDATED|hygiene/i.test(h.why || ''));
    if (closed.length < 6) { lesson(`only ${closed.length} graded trades — not enough evidence to tune anything today`); bus.markDirty && bus.markDirty(); return; }

    // EVAL 1 — exits: are we leaving money on the table, or overstaying?
    if (P.leftOnTable != null) {
      if (P.leftOnTable > 1.2) {
        t.quickTake = clampB('quickTake', (t.quickTake || 0.01) + 0.002);
        t.trailGap = clampB('trailGap', (t.trailGap || 0.005) + 0.001);
        lesson(`left ${P.leftOnTable}% on the table on average — letting winners run longer (quickTake→${t.quickTake}, trailGap→${t.trailGap})`);
      } else if (P.leftOnTable < 0.3 && (P.winRate || 0) < 45) {
        t.quickTake = clampB('quickTake', (t.quickTake || 0.01) - 0.001);
        t.trailGap = clampB('trailGap', (t.trailGap || 0.005) - 0.001);
        lesson(`exits near-optimal but win rate ${P.winRate}% — banking slightly earlier (quickTake→${t.quickTake}, trailGap→${t.trailGap})`);
      } else lesson(`exit quality OK — left-on-table ${P.leftOnTable}%, win rate ${P.winRate}%; no exit tuning needed`);
    }

    // EVAL 2 — spike lane: is it earning its keep?
    const spikes = (P.bySig || []).find(s => s.sig === 'SPIKE');
    if (spikes && spikes.wins + spikes.losses >= 8) {
      if (spikes.pnl < 0) { t.spikeVol = clampB('spikeVol', (t.spikeVol || 1.8) + 0.2); lesson(`SPIKE lane net ${spikes.pnl} over ${spikes.wins + spikes.losses} trades — demanding rarer, stronger spikes (vol≥${t.spikeVol}×)`); }
      else if (spikes.pnl > 0.5 && t.spikeVol > 1.8) { t.spikeVol = clampB('spikeVol', t.spikeVol - 0.1); lesson(`SPIKE lane profitable (+${spikes.pnl}) — easing the volume bar back (vol≥${t.spikeVol}×)`); }
    }

    // EVAL 3 — name the day's best and worst signal types so the record teaches
    const ranked = (P.bySig || []).filter(s => s.wins + s.losses >= 3);
    if (ranked.length) {
      const best = ranked[0], worst = ranked[ranked.length - 1];
      lesson(`scoreboard: best signal ${best.sig} (${best.pnl >= 0 ? '+' : ''}${best.pnl}), worst ${worst.sig} (${worst.pnl}) — the learner weights follow`);
    }

    bus.coachStatus = { lessons: state.coach.lessons.length, lastRun: today, tuned: t };
    if (bus.notify) bus.notify(`🎓 Coach ran: ${state.coach.lessons[0] ? state.coach.lessons[0].msg : 'no changes'}`);
    bus.markDirty && bus.markDirty();
  }

  setInterval(evaluate, 5 * 60e3);
  setTimeout(evaluate, 90e3);   // first pass shortly after boot (a post-21:00 deploy shouldn't wait 5 min)
  console.log('[coach] self-improvement loop armed — grades each day after the close, tunes within hard bounds');
}
module.exports = { start };
