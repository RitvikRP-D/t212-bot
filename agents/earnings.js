'use strict';
// AGENT ⑲: EARNINGS BLACKOUT — holding a stock through its earnings report is a coin-flip
// gap that can blow past your stop. Pulls the free Nasdaq earnings calendar for the next
// few trading days; the trader (real profile) then refuses to enter a name that reports
// imminently and exits a holding the day before it reports. Fails open (US names only —
// if the feed is down, no blackout is applied and everything else runs normally).
const REFRESH = 4 * 3600e3;

function start(bus) {
  bus.earnings = { soon: {}, count: 0, updated: null };   // US base symbol -> 'YYYY-MM-DD'

  const fmt = (d) => d.toISOString().slice(0, 10);
  async function day(dateStr) {
    try {
      const r = await fetch('https://api.nasdaq.com/api/calendar/earnings?date=' + dateStr,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/120', 'Accept': 'application/json' } });
      const j = await r.json().catch(() => null);
      return (j && j.data && j.data.rows || []).map(x => String(x.symbol || '').toUpperCase()).filter(Boolean);
    } catch (e) { return []; }
  }
  async function refresh() {
    const soon = {}; const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now + i * 86400e3);
      const wd = d.getUTCDay(); if (wd === 0 || wd === 6) continue;   // skip weekends
      const syms = await day(fmt(d));
      for (const s of syms) if (!(s in soon)) soon[s] = fmt(d);
    }
    if (Object.keys(soon).length) {
      bus.earnings.soon = soon;
      bus.earnings.count = Object.keys(soon).length;
      bus.earnings.updated = new Date().toLocaleTimeString();
    }
  }

  // days until this symbol reports, or null if not on the near calendar
  bus.earningsInDays = (sym) => {
    const base = String(sym).split('.')[0].replace('-', '.');   // US base ticker
    const d = bus.earnings.soon[base];
    if (!d) return null;
    return Math.round((new Date(d + 'T00:00:00Z').getTime() - Date.now()) / 86400e3);
  };

  refresh(); setInterval(refresh, REFRESH);
  console.log('[earnings] blackout agent started — Nasdaq calendar, next 6 trading days');
}
module.exports = { start };
