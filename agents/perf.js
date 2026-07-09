'use strict';
// AGENT ㉒: PERFORMANCE MONITOR — the fleet's self-awareness. Reads closed trades and
// computes win rate, avg win vs avg loss, profit factor, current losing streak, per-signal
// performance and a per-AGENT scorecard (which agents' votes actually preceded winners).
// If the system is clearly tilting — win rate collapses or several losses stack up — it
// sets a cool-off window that pauses NEW entries so it stops digging (existing positions
// keep their stops). Publishes bus.perf; alerts once per new cool-off.
function start(bus) {
  const state = bus.state;
  bus.perf = { winRate: null, closed: 0, avgWin: 0, avgLoss: 0, profitFactor: null, streak: 0, coolOffUntil: 0, bySig: [], byAgent: [], updated: null };
  let warned = 0;

  function cycle() {
    if (bus.beat) bus.beat('perf');   // loop alive even before the first closed trade
    // capital-rotation ops (dead-money recycling, risk liquidations) are not SIGNAL
    // outcomes — counting them collapsed the win rate and tripped false cool-offs
    const closed = state.history.filter(h => h.pnl != null && h.action === 'SELL' && !/dead money|LIQUIDATED/i.test(h.why || ''));
    bus.perf.closed = closed.length;
    if (!closed.length) { bus.perf.updated = new Date().toLocaleTimeString(); return; }
    const wins = closed.filter(h => h.pnl > 0), losses = closed.filter(h => h.pnl <= 0);
    const sum = a => a.reduce((x, h) => x + h.pnl, 0);
    const avgWin = wins.length ? sum(wins) / wins.length : 0;
    const avgLoss = losses.length ? sum(losses) / losses.length : 0;
    const winRate = Math.round(wins.length / closed.length * 100);
    const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
    const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null;
    // current losing streak from the most-recent closes backward
    let streak = 0;
    for (const h of closed) { if (h.pnl <= 0) streak++; else break; }   // history is newest-first

    // per-signal (from the learner ledger, which already tracks wins/losses/pnl)
    const bySig = Object.entries(state.learn || {}).filter(([k]) => k.endsWith(':ALL'))
      .map(([k, v]) => ({ sig: k.replace(':ALL', ''), wins: v.wins, losses: v.losses, pnl: +v.pnl.toFixed(2), rate: v.wins + v.losses ? Math.round(v.wins / (v.wins + v.losses) * 100) : null }))
      .sort((a, b) => b.pnl - a.pnl);

    // per-agent scorecard: each closed trade records which agents' votes backed the entry
    // (trader stamps h.votes on the BUY; we match the SELL to its BUY by symbol+recency).
    const buys = state.history.filter(h => h.action === 'BUY' && h.votes);
    const agg = {};
    for (const sell of closed) {
      const buy = buys.find(b => b.sym === sell.sym);   // nearest prior buy for that symbol
      if (!buy || !buy.votes) continue;
      for (const ag of buy.votes) { const a = agg[ag] = agg[ag] || { wins: 0, losses: 0, pnl: 0 }; sell.pnl > 0 ? a.wins++ : a.losses++; a.pnl += sell.pnl; }
    }
    const byAgent = Object.entries(agg).map(([agent, v]) => ({ agent, wins: v.wins, losses: v.losses, pnl: +v.pnl.toFixed(2), rate: v.wins + v.losses ? Math.round(v.wins / (v.wins + v.losses) * 100) : null }))
      .sort((a, b) => (b.rate || 0) - (a.rate || 0));

    // tilt guard → cool-off (pause new entries), auto-expiring
    const now = Date.now();
    let coolOffUntil = bus.perf.coolOffUntil || 0;
    let reason = null;
    if (closed.length >= 8 && winRate < 45 && now > coolOffUntil) { coolOffUntil = now + 2 * 3600e3; reason = `win rate ${winRate}% over ${closed.length} trades`; }
    else if (streak >= 3 && now > coolOffUntil) { coolOffUntil = now + 1 * 3600e3; reason = `${streak} losses in a row`; }

    // LEFT-ON-TABLE — mean gap between each trade's peak unrealized gain and where it
    // actually exited. Large gap = exits too slow/loose; near zero = exits near-optimal.
    const withPeak = closed.filter(h => h.peakPct != null && h.gainPct != null);
    const leftOnTable = withPeak.length ? +(withPeak.reduce((a, h) => a + Math.max(0, h.peakPct - h.gainPct), 0) / withPeak.length).toFixed(2) : null;

    bus.perf = { winRate, closed: closed.length, avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2), profitFactor, streak, coolOffUntil, leftOnTable, bySig: bySig.slice(0, 12), byAgent, updated: new Date().toLocaleTimeString() };

    // DAILY 9PM SUMMARY — one honest recap pushed to the operator after the US close.
    const ukHour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()), 10);
    const todayKey = new Date().toDateString();
    if (ukHour >= 21 && state.lastDailySummary !== todayKey && bus.notify) {
      state.lastDailySummary = todayKey;
      const dg = bus.riskStatus && bus.riskStatus.dayGain;
      bus.notify(`📊 Day recap — equity move ${dg != null ? dg + '%' : 'n/a'} · ${closed.length} trades closed all-time · win rate ${winRate}% · avg win ${avgWin.toFixed(2)} vs avg loss ${avgLoss.toFixed(2)}${leftOnTable != null ? ' · avg left-on-table ' + leftOnTable + '%' : ''}. Tomorrow starts fresh at the bell.`);
      if (bus.markDirty) bus.markDirty();
    }
    if (reason && coolOffUntil > now && warned !== coolOffUntil) {
      warned = coolOffUntil;
      console.log('[perf] cool-off: ' + reason);
      if (bus.notify) bus.notify(`⏸ Performance cool-off — ${reason}. Pausing new entries for a bit (open positions keep their stops).`);
    }
  }
  // trader consults this before entering
  bus.perfBlocked = () => (bus.perf.coolOffUntil || 0) > Date.now();

  setInterval(cycle, 30e3);
  setTimeout(cycle, 15e3);
  console.log('[perf] performance monitor + scorecard armed');
}
module.exports = { start };
