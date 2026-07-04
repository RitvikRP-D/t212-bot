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
  queue = queue.then(async () => {
    const wait = Math.max(0, lastCall + T212_SPACING_MS - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  }).catch(e => {
    // queue rejection should propagate but not poison future calls
    console.error('[t212] queue error:', e.message);
    throw e;
  });
  return queue;
}
async function raw(path, opts = {}, hdr) {
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
