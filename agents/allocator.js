'use strict';
// AGENT ⑰: ALLOCATOR — the capital dispatcher + overnight order queue.
// Trading212 can only FILL orders while its exchanges are open (crypto ETPs and
// commodity ETCs trade on LSE/Xetra — there is no 24h venue on T212). So: any
// agent that finds conviction while the venue sleeps calls bus.queueSignal();
// the allocator holds the queue, keeps it fresh, and FIRES every qualifying
// order within seconds of the opening bell — capital never oversleeps.
// It also pushes queued names onto the scanner's hot list so live prices are
// ready the moment the market opens.
const { ALLOC_MS, QUEUE_MIN_CONF, marketOpen } = require('../config');

function start(bus) {
  const state = bus.state;
  state.queue = state.queue || {};
  bus.allocStatus = { checked: null, queued: 0, fired: 0, expired: 0, lastFired: null };

  // any agent calls this: sym must be a Yahoo-style T212-tradable symbol
  bus.queueSignal = (sym, conf, reason, src) => {
    if (conf < QUEUE_MIN_CONF) return;
    if (state.t212.positions[sym]) return;  // already holding
    // CRYPTO & COMMODITIES: fire immediately, don't queue.
    // T212 will fill them as soon as their venue opens; janitor cleans any stale orders.
    if ((src === 'crypto' || src === 'commodity') && bus.market[sym] && bus.market[sym].price != null) {
      const mk = bus.market[sym];
      mk.queuedBoost = { conf: +conf.toFixed(2), reason: `${src} 24/7 signal: ${reason.slice(0, 150)}`, until: Date.now() + 30 * 60e3 };
      if (bus.tryEnter) bus.tryEnter(sym, mk);
      bus.allocStatus.fired++;
      return;
    }
    // STOCKS: queue until venue open
    if (marketOpen(sym)) return;            // venue open → trader handles it live
    const q = state.queue[sym];
    if (!q || conf > q.conf) {
      state.queue[sym] = { conf: +conf.toFixed(2), reason: reason.slice(0, 200), src, queuedAt: q ? q.queuedAt : Date.now() };
      bus.markDirty();
    }
  };

  function tick() {
    bus.allocStatus.checked = new Date().toLocaleTimeString();
    bus.allocStatus.queued = Object.keys(state.queue).length;
    if (!bus.riskGate || !bus.riskGate.canEnter()) return;
    for (const [sym, q] of Object.entries(state.queue)) {
      // keep queued names hot so the scanner refreshes their price around the bell
      if (bus.tvHot && !bus.tvHot.includes(sym)) bus.tvHot.push(sym);
      if (!marketOpen(sym)) continue;
      const mk = bus.market[sym];
      if (!mk || mk.price == null || mk.rsi == null) continue;  // waiting for first live candle
      // venue is OPEN and we have live data → hand to trader with the queued conviction
      if (bus.tryEnter) {
        mk.queuedBoost = { conf: q.conf, reason: `queued overnight (${q.src}): ${q.reason}`, until: Date.now() + 10 * 60e3 };
        bus.tryEnter(sym, mk);
        bus.allocStatus.fired++;
        bus.allocStatus.lastFired = `${sym} @${new Date().toLocaleTimeString()}`;
        delete state.queue[sym];
        bus.markDirty();
      }
    }
  }

  setInterval(() => { try { tick(); } catch (e) {} }, ALLOC_MS);
  console.log('[allocator] order queue armed — overnight conviction fires at the opening bell');
}
module.exports = { start };
