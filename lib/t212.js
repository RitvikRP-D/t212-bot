'use strict';
// Trading212 client. Auth per official docs: HTTP Basic base64(keyId:secret).
// SAFETY: defaults to the DEMO (practice) environment. It only touches the LIVE
// real-money account when T212_LIVE is explicitly set to true/yes/1/live — so an
// accidental or default run can NEVER place a real order. The chosen mode is logged
// loudly on startup.
const LIVE = /^(true|yes|1|live)$/i.test((process.env.T212_LIVE || '').trim());
const HOST = LIVE ? 'https://live.trading212.com/api/v0' : 'https://demo.trading212.com/api/v0';
console.log(LIVE
  ? '[t212] ⚠️  LIVE REAL-MONEY MODE — orders hit your real Trading212 account'
  : '[t212] practice mode — demo.trading212.com (no real money)');
const { T212_SPACING_MS } = require('../config');

let authHeader = null;
let lastCall = 0;
let queue = Promise.resolve();

function throttled(fn) {
  // `result` is what the caller gets back — if fn() throws, THIS rejects and the
  // caller sees it. `queue` (the shared chain used only to space calls apart) must
  // never itself become a rejected promise: chaining .then() onto a rejected promise
  // with no rejection handler just forwards the rejection WITHOUT running the next
  // fn() at all — so one failed call would silently no-op every future T212 call for
  // the rest of the process's life. Swallowing the error only on `queue` (never on
  // `result`) keeps the chain alive while still surfacing the real error per-call.
  const result = queue.then(async () => {
    const wait = Math.max(0, lastCall + T212_SPACING_MS - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = result.catch(e => { console.error('[t212] queue error:', e.message); });
  return result;
}
// Per-endpoint 429 cooldown. T212 uses a sliding rate-limit window — every request
// sent while throttled EXTENDS the throttle, which is how a "20-minute" limit once
// dragged on for hours. On a 429 we stop touching that path for the Retry-After
// duration (or 5 min if the header is absent) and short-circuit locally instead.
const cooldownUntil = {};
async function raw(path, opts = {}, hdr) {
  const pathKey = path.split('?')[0];
  if (cooldownUntil[pathKey] && Date.now() < cooldownUntil[pathKey]) {
    return { status: 429, body: { errorMessage: 'local cooldown — endpoint rate-limited, backing off until ' + new Date(cooldownUntil[pathKey]).toLocaleTimeString() } };
  }
  const controller = new AbortController();
  // 20s default; large downloads (16k-instrument metadata is several MB) get longer —
  // on cloud hosts the old flat 15s aborted mid-download and spammed queue errors.
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs || 20000);
  try {
    const r = await fetch(HOST + path, {
      ...opts,
      signal: controller.signal,
      headers: { 'Authorization': hdr || authHeader, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = text; }
    // Detect 401/403 and clear auth so retry loop fires
    if (r.status === 401 || r.status === 403) authHeader = null;
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('retry-after'), 10);
      cooldownUntil[pathKey] = Date.now() + (isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5 * 60e3);
      console.log(`[t212] 429 on ${pathKey} — backing off until ${new Date(cooldownUntil[pathKey]).toLocaleTimeString()}`);
    }
    return { status: r.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function connect(keyId, secret) {
  const basic = 'Basic ' + Buffer.from(keyId + ':' + secret).toString('base64');
  const candidates = [
    { name: 'basic (documented)', hdr: basic },
    { name: 'legacy key header', hdr: keyId },
    { name: 'legacy secret header', hdr: secret },
  ];
  for (const c of candidates) {
    for (const path of ['/equity/account/cash', '/equity/account/summary']) {
      try {
        const r = await raw(path, {}, c.hdr);
        if (r.status === 200 && r.body && typeof r.body === 'object') {
          authHeader = c.hdr;
          return { ok: true, scheme: c.name, endpoint: path, data: r.body };
        }
        if (r.status === 403) {
          return { ok: false, error: `Key authenticated but lacks permission scopes (403 on ${path}) — edit the key in the T212 app and tick all scopes.` };
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { ok: false, error: '401 unauthorized on every documented scheme — check the key has scopes ticked, or delete it and generate a new one in the PRACTICE account, then update t212-bot/.env' };
}

module.exports = {
  connected: () => !!authHeader,
  isLive: () => LIVE,
  connect,
  cash: () => throttled(() => raw('/equity/account/cash')),
  summary: () => throttled(() => raw('/equity/account/summary')),
  portfolio: () => throttled(() => raw('/equity/portfolio')),
  instruments: () => throttled(() => raw('/equity/metadata/instruments', { timeoutMs: 90000 })),
  marketOrder: (ticker, quantity) => throttled(() => raw('/equity/orders/market', { method: 'POST', body: JSON.stringify({ ticker, quantity }) })),
  limitOrder: (ticker, quantity, limitPrice, timeValidity = 'DAY') => throttled(() => raw('/equity/orders/limit', { method: 'POST', body: JSON.stringify({ ticker, quantity, limitPrice, timeValidity }) })),
  orders: () => throttled(() => raw('/equity/orders')),
  cancelOrder: (id) => throttled(() => raw('/equity/orders/' + id, { method: 'DELETE' })),
};
