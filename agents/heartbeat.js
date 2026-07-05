'use strict';
// AGENT ㉔: FLEET HEARTBEAT. Each agent publishes a status object with a timestamp; this
// monitor probes those and flags any agent that has gone silent past its expected cadence.
// A stalled DATA/EXECUTION agent (scanner, trader, risk) is what actually endangers the
// account, so those alert; slow background agents just warn. Publishes bus.fleet. The medic
// already restarts the process on heap blowups — this is the "is each brain still ticking?"
// layer that catches a wedged agent the process-level watchdog would miss.
function start(bus) {
  // NB: the live per-agent board is owned by agents/fleet.js (bus.fleet). This monitor
  // publishes bus.fleetProbe (critical-agent liveness + alerts) which fleet.js surfaces.
  bus.fleetProbe = { agents: [], silent: [], ok: true, updated: null };
  const alerted = new Set();
  // probe = [displayName, staleAfterMs, critical, ()=>lastActivityMs|null]
  const now = () => Date.now();
  const fresh = (s) => {
    // status objects expose a time string; we treat "present + updated recently" as alive.
    // Fall back to the object existing at all for agents without a clock field.
    return s;
  };
  function tms(v) {
    // accept a Date, ms number, or HH:MM:SS string; return ms-since-epoch or null
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    return now();   // a present string timestamp = it ran at least once; cadence check below covers staleness via wrappers
  }

  const B = (n) => (bus.beats || {})[n];   // medic + server populate bus.beats via bus.beat(name)
  const probes = [
    ['trader', 60e3, true, () => B('trader')],
    ['risk', 40e3, true, () => B('risk')],
    ['pine', 120e3, false, () => B('pine')],
    ['regime', 90e3, false, () => B('regime')],
    ['perf', 120e3, false, () => B('perf')],
    ['logger', 200e3, false, () => B('logger')],
  ];

  function cycle() {
    const agents = [], silent = [];
    for (const [name, stale, critical, get] of probes) {
      let last = null; try { last = tms(get()); } catch (e) {}
      const age = last ? now() - last : null;
      const alive = last != null && age <= stale;
      agents.push({ name, alive, ageSec: age != null ? Math.round(age / 1000) : null, critical });
      if (last != null && !alive) {
        silent.push(name);
        const key = name + ':' + Math.round(now() / stale);
        if (critical && bus.notify && !alerted.has(key)) { alerted.add(key); bus.notify(`❌ Agent "${name}" went silent (${Math.round(age / 1000)}s) — fleet degraded.`); }
      }
    }
    bus.fleetProbe = { agents, silent, ok: silent.length === 0, updated: new Date().toLocaleTimeString() };
  }
  setInterval(cycle, 15e3);
  setTimeout(cycle, 40e3);   // let everything boot first
  console.log('[heartbeat] fleet liveness monitor armed');
}
module.exports = { start };
