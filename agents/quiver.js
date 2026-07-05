'use strict';
// AGENT: QUIVER QUANTITATIVE connector — OPTIONAL, key-gated.
// Quiver's API is NOT free (a request with no token returns HTTP 401), so this agent
// stays dormant until a QUIVER_API_KEY (or QUIVER_TOKEN) env var is present. The moment
// it is, it pulls the signals Quiver is famous for — congressional trading, government
// contracts, and (where the plan allows) their political datasets — and turns them into
// tradeable momentum reads that the Trump desk + trader fold in as advisory input.
//
// To activate: set QUIVER_API_KEY in the Railway service variables. Nothing else changes.
const KEY = process.env.QUIVER_API_KEY || process.env.QUIVER_TOKEN || null;
const BASE = 'https://api.quiverquant.com';
const POLL_MS = 5 * 60e3;   // 5 min — congress/contract data is slow-moving

async function q(path) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(BASE + path, { signal: ac.signal, headers: { Authorization: 'Token ' + KEY, Accept: 'application/json' } });
    if (!r.ok) return { error: r.status };
    return { data: await r.json() };
  } catch (e) { return { error: e.message }; } finally { clearTimeout(t); }
}

function start(bus) {
  if (!KEY) {
    bus.quiver = { enabled: false, note: 'Quiver API is paid — set QUIVER_API_KEY in the service variables to activate (congress trades + gov contracts + political data).' };
    bus.quiverSignal = {};
    console.log('[quiver] dormant — no QUIVER_API_KEY set (free house-stock-watcher congress data still active via news agent)');
    return;
  }
  bus.quiver = { enabled: true, congress: [], contracts: [], signals: {}, errors: 0, updated: null };
  bus.quiverSignal = {};

  async function poll() {
    if (bus.beat) bus.beat('quiver');
    const clamp = v => Math.max(-1, Math.min(1, v));
    const sig = {};
    const add = (sym, v) => { if (sym) sig[sym] = clamp((sig[sym] || 0) + v); };

    // 1) Congressional trading — recent cluster buys = bullish momentum
    const ct = await q('/beta/live/congresstrading');
    if (ct.data && Array.isArray(ct.data)) {
      const rows = ct.data.slice(0, 400);
      const byTk = {};
      for (const r of rows) {
        const tk = (r.Ticker || r.ticker || '').toUpperCase(); if (!tk) continue;
        const buy = /purchase|buy/i.test(r.Transaction || r.transaction || r.type || '');
        (byTk[tk] = byTk[tk] || { buys: 0, sells: 0, reps: new Set() });
        if (buy) byTk[tk].buys++; else byTk[tk].sells++;
        byTk[tk].reps.add(r.Representative || r.representative || r.Senator || '');
      }
      bus.quiver.congress = Object.entries(byTk).map(([sym, v]) => ({ sym, buys: v.buys, sells: v.sells, reps: v.reps.size }))
        .sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells)).slice(0, 20);
      for (const c of bus.quiver.congress) add(c.sym, (c.buys - c.sells) * 0.06 + (c.reps > 2 ? 0.1 : 0));
    } else if (ct.error) bus.quiver.errors++;

    // 2) Government contracts — a fresh award is a revenue tailwind
    const gc = await q('/beta/live/govcontractsall');
    if (gc.data && Array.isArray(gc.data)) {
      const byTk = {};
      for (const r of gc.data.slice(0, 400)) {
        const tk = (r.Ticker || r.ticker || '').toUpperCase(); if (!tk) continue;
        byTk[tk] = (byTk[tk] || 0) + (+(r.Amount || r.amount || 0) || 1);
      }
      bus.quiver.contracts = Object.entries(byTk).map(([sym, amt]) => ({ sym, amount: amt })).sort((a, b) => b.amount - a.amount).slice(0, 20);
      for (const c of bus.quiver.contracts.slice(0, 10)) add(c.sym, 0.1);
    } else if (gc.error) bus.quiver.errors++;

    bus.quiver.signals = sig;
    bus.quiverSignal = sig;                 // trader/trump fold this in (bounded)
    bus.quiver.updated = new Date().toLocaleTimeString();
    console.log(`[quiver] refreshed — ${bus.quiver.congress.length} congress names, ${bus.quiver.contracts.length} contract names, ${Object.keys(sig).length} signals`);
  }

  poll(); setInterval(poll, POLL_MS);
  console.log('[quiver] ACTIVE — QUIVER_API_KEY detected, pulling congress trades + gov contracts every 5m');
}
module.exports = { start };
