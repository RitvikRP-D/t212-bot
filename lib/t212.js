'use strict';
// Trading212 PRACTICE-ONLY client. Auth per official docs: HTTP Basic base64(keyId:secret).
// SAFETY: host hard-coded to demo environment — this module cannot reach the live account.
const HOST = 'https://demo.trading212.com/api/v0';
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
  });
  return queue;
}
async function raw(path, opts = {}, hdr) {
  const r = await fetch(HOST + path, {
    ...opts,
    headers: { 'Authorization': hdr || authHeader, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: r.status, body };
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
  connect,
  cash: () => throttled(() => raw('/equity/account/cash')),
  summary: () => throttled(() => raw('/equity/account/summary')),
  portfolio: () => throttled(() => raw('/equity/portfolio')),
  instruments: () => throttled(() => raw('/equity/metadata/instruments')),
  marketOrder: (ticker, quantity) => throttled(() => raw('/equity/orders/market', { method: 'POST', body: JSON.stringify({ ticker, quantity }) })),
  orders: () => throttled(() => raw('/equity/orders')),
  cancelOrder: (id) => throttled(() => raw('/equity/orders/' + id, { method: 'DELETE' })),
};
