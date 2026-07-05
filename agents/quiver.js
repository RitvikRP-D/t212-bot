'use strict';
// AGENT: QUIVER QUANTITATIVE connector.
// Auth per their docs: `Authorization: Bearer <API_KEY>` against api.quiverquant.com.
// (Older REST used `Token <key>`, so we try Bearer first then Token and cache whichever
// the key accepts.) The key can come from EITHER the QUIVER_API_KEY env var OR be pasted
// into the dashboard at runtime (Controls tab → bus.quiverKey, persisted in state) — so
// it can be switched on with zero redeploys. Until a key is present it stays dormant and
// the FREE house-stock-watcher congress data keeps feeding the Trump desk regardless.
const BASE = 'https://api.quiverquant.com';
const POLL_MS = 5 * 60e3;

function start(bus) {
  bus.quiver = { enabled: false, note: 'No Quiver key yet — paste one in the Controls tab (free signup at api.quiverquant.com/pricing) to add congress trades + gov contracts.' };
  bus.quiverSignal = {};
  let authScheme = null;   // cached once we learn which the key accepts

  const getKey = () => process.env.QUIVER_API_KEY || process.env.QUIVER_TOKEN || bus.quiverKey || null;

  async function q(path, key) {
    const schemes = authScheme ? [authScheme] : ['Bearer', 'Token'];
    for (const scheme of schemes) {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
      try {
        const r = await fetch(BASE + path, { signal: ac.signal, headers: { Authorization: `${scheme} ${key}`, Accept: 'application/json' } });
        if (r.status === 401 || r.status === 403) { if (!authScheme) continue; return { error: r.status, auth: true }; }
        if (!r.ok) return { error: r.status };
        authScheme = scheme;                 // remember what worked
        return { data: await r.json() };
      } catch (e) { return { error: e.message }; } finally { clearTimeout(t); }
    }
    return { error: 401, auth: true };
  }

  async function poll() {
    if (bus.beat) bus.beat('quiver');
    const key = getKey();
    if (!key) { bus.quiver = { enabled: false, note: 'No Quiver key yet — paste one in the Controls tab (free signup at api.quiverquant.com/pricing).' }; bus.quiverSignal = {}; return; }

    const clamp = v => Math.max(-1, Math.min(1, v));
    const sig = {};
    const add = (sym, v) => { if (sym) sig[sym] = clamp((sig[sym] || 0) + v); };
    const out = { enabled: true, source: process.env.QUIVER_API_KEY ? 'env' : 'dashboard', congress: [], contracts: [], signals: {}, errors: 0, updated: null, authScheme: null };

    // fetch both endpoints, THEN decide — so a bad key/plan is reported honestly instead
    // of showing "ACTIVE" with no data.
    const ct = await q('/beta/live/congresstrading', key);
    const gc = await q('/beta/live/govcontractsall', key);
    const isAuth = e => e === 401 || e === 403;
    const authFail = ct.auth || gc.auth || isAuth(ct.error) || isAuth(gc.error);
    const gotData = (Array.isArray(ct.data) && ct.data.length) || (Array.isArray(gc.data) && gc.data.length);
    if (!gotData) {
      bus.quiver = authFail
        ? { enabled: false, keyRejected: true, note: 'Quiver rejected the key (401/403). A free signup may not include API access — programmatic API is a paid plan (from $30/mo). Free house-stock-watcher congress data is still live on the Trump desk.' }
        : { enabled: false, error: true, note: `Quiver key set but returned no data (congress:${ct.error || 'ok?'}, contracts:${gc.error || 'ok?'}). Check the key or your plan tier.` };
      bus.quiverSignal = {};
      console.log(`[quiver] no data — ${authFail ? 'key rejected (401/403)' : 'errors ct:' + ct.error + ' gc:' + gc.error}`);
      return;
    }

    // 1) Congressional trading — recent cluster buys = bullish momentum
    if (ct.data && Array.isArray(ct.data)) {
      const byTk = {};
      for (const r of ct.data.slice(0, 400)) {
        const tk = (r.Ticker || r.ticker || '').toUpperCase(); if (!tk) continue;
        const buy = /purchase|buy/i.test(r.Transaction || r.transaction || r.type || '');
        (byTk[tk] = byTk[tk] || { buys: 0, sells: 0, reps: new Set() });
        if (buy) byTk[tk].buys++; else byTk[tk].sells++;
        byTk[tk].reps.add(r.Representative || r.representative || r.Senator || '');
      }
      out.congress = Object.entries(byTk).map(([sym, v]) => ({ sym, buys: v.buys, sells: v.sells, reps: v.reps.size }))
        .sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells)).slice(0, 20);
      for (const c of out.congress) add(c.sym, (c.buys - c.sells) * 0.06 + (c.reps > 2 ? 0.1 : 0));
    } else if (ct.error) out.errors++;

    // 2) Government contracts — a fresh award is a revenue tailwind (gc fetched above)
    if (gc.data && Array.isArray(gc.data)) {
      const byTk = {};
      for (const r of gc.data.slice(0, 400)) {
        const tk = (r.Ticker || r.ticker || '').toUpperCase(); if (!tk) continue;
        byTk[tk] = (byTk[tk] || 0) + (+(r.Amount || r.amount || 0) || 1);
      }
      out.contracts = Object.entries(byTk).map(([sym, amt]) => ({ sym, amount: amt })).sort((a, b) => b.amount - a.amount).slice(0, 20);
      for (const c of out.contracts.slice(0, 10)) add(c.sym, 0.1);
    } else if (gc.error) out.errors++;

    out.signals = sig; out.authScheme = authScheme;
    out.updated = new Date().toLocaleTimeString();
    bus.quiver = out;
    bus.quiverSignal = sig;
    console.log(`[quiver] refreshed via ${authScheme} — ${out.congress.length} congress names, ${out.contracts.length} contract names, ${Object.keys(sig).length} signals`);
  }

  // Loop every 30s (so a freshly-pasted key validates fast) but only actually FETCH from
  // Quiver at most every POLL_MS — the light-touch ticks in between just watch for a key.
  let lastFetch = 0, lastKey = null;
  async function loop() {
    const key = getKey();
    const keyChanged = key !== lastKey; lastKey = key;
    if (!key) { if (bus.quiver.enabled !== false) { bus.quiver = { enabled: false, note: 'Quiver key removed.' }; bus.quiverSignal = {}; } return; }
    if (keyChanged || Date.now() - lastFetch > POLL_MS) { authScheme = keyChanged ? null : authScheme; await poll(); lastFetch = Date.now(); }
  }
  loop(); setInterval(loop, 30000);
  const k = getKey();
  console.log(k ? '[quiver] key present — polling congress trades + gov contracts every 5m'
                : '[quiver] dormant — no key yet (paste in dashboard Controls, or set QUIVER_API_KEY). Free congress data still active.');
}
module.exports = { start };
