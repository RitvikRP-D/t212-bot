'use strict';
// AGENT ⑯: MARKET MAPPER — the fleet's air-traffic controller. Tracks every venue
// (8 stock exchanges + crypto 24/7 + Globex futures ~23h), what's open RIGHT NOW,
// minutes to each open/close, how many tradable symbols and live signals sit in
// each, and tells the fleet where to point its capital: stocks when bells ring,
// crypto/commodities when the world sleeps.
const { MARKETMAP_MS, marketOpen } = require('../config');

const HOURS = {
  US: { tz: 'America/New_York', open: [9, 30], close: [16, 0], label: 'New York' },
  L:  { tz: 'Europe/London',    open: [8, 0],  close: [16, 30], label: 'London' },
  DE: { tz: 'Europe/Berlin',    open: [9, 0],  close: [17, 30], label: 'Frankfurt' },
  PA: { tz: 'Europe/Paris',     open: [9, 0],  close: [17, 30], label: 'Paris' },
  AS: { tz: 'Europe/Amsterdam', open: [9, 0],  close: [17, 30], label: 'Amsterdam' },
  SW: { tz: 'Europe/Zurich',    open: [9, 0],  close: [17, 30], label: 'Zurich' },
  MI: { tz: 'Europe/Rome',      open: [9, 0],  close: [17, 30], label: 'Milan' },
  MC: { tz: 'Europe/Madrid',    open: [9, 0],  close: [17, 30], label: 'Madrid' },
};

function venueClock(h) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: h.tz, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const wd = get('weekday'), mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  const o = h.open[0] * 60 + h.open[1], c = h.close[0] * 60 + h.close[1];
  const weekend = wd === 'Sat' || wd === 'Sun';
  const open = !weekend && mins >= o && mins < c;
  let minsToOpen = null;
  if (!open) {
    if (!weekend && mins < o) minsToOpen = o - mins;
    else minsToOpen = (wd === 'Sat' ? 2 : wd === 'Sun' ? 1 : 1) * 1440 - mins + o; // rough: next weekday
  }
  return { open, minsToOpen, minsToClose: open ? c - mins : null };
}

function start(bus) {
  bus.marketMap = { venues: [], openVenues: 0, focus: null, nextBell: null, updated: null };

  function build() {
    const venues = [];
    const perVenue = {};
    for (const u of bus.universe) {
      const v = u.y.includes('.') ? u.y.split('.')[1] : 'US';
      perVenue[v] = (perVenue[v] || 0) + 1;
    }
    let nextBell = null;
    for (const [v, h] of Object.entries(HOURS)) {
      const clk = venueClock(h);
      let signals = 0;
      for (const [sym, m] of Object.entries(bus.market)) {
        const sv = sym.includes('.') ? sym.split('.')[1] : 'US';
        if (sv === v && (m.lastConf || 0) >= 0.5) signals++;
      }
      venues.push({ venue: v, label: h.label, open: clk.open, minsToOpen: clk.minsToOpen, minsToClose: clk.minsToClose, symbols: perVenue[v] || 0, hotSignals: signals });
      if (!clk.open && clk.minsToOpen != null && (!nextBell || clk.minsToOpen < nextBell.mins))
        nextBell = { venue: h.label, mins: clk.minsToOpen };
    }
    // 24/7 and near-24h venues
    const cryptoSignals = Object.values(bus.crypto || {}).filter(c => (c.conf || 0) >= 0.5).length;
    const commodSignals = Object.values(bus.commod || {}).filter(c => (c.conf || 0) >= 0.5).length;
    venues.push({ venue: 'CRYPTO', label: 'Binance (analysis 24/7 → T212 ETPs at bell)', open: true, symbols: (bus.cryptoStatus?.coins || 0), hotSignals: cryptoSignals });
    venues.push({ venue: 'FUTURES', label: 'Globex ~23h (→ T212 ETCs at bell)', open: true, symbols: (bus.commodStatus?.targets || 0), hotSignals: commodSignals });

    const stocksOpen = venues.filter(v => v.open && v.venue !== 'CRYPTO' && v.venue !== 'FUTURES').length;
    bus.marketMap = {
      venues, openVenues: stocksOpen,
      focus: stocksOpen > 0 ? `stocks (${stocksOpen} exchanges open) + crypto + commodities` : 'crypto + commodities (all exchanges closed — queueing stock conviction for next bell)',
      nextBell: nextBell ? `${nextBell.venue} in ${Math.floor(nextBell.mins / 60)}h${nextBell.mins % 60}m` : null,
      queued: Object.keys(bus.state.queue || {}).length,
      updated: new Date().toLocaleTimeString(),
    };
  }

  setInterval(() => { try { build(); } catch (e) {} }, MARKETMAP_MS);
  setTimeout(build, 3000);
  console.log('[marketmap] air-traffic controller online — tracking 10 venues');
}
module.exports = { start };
