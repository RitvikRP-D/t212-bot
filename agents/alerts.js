'use strict';
// AGENT ⑱: EMAIL ALERTS — pings your inbox on every trade, halt, daily profit-lock and
// loss-breaker. Free via Resend (plain HTTP, no SMTP, no dependency, no app-password):
//   1. sign up free at resend.com with your Gmail
//   2. create an API key
//   3. set RESEND_API_KEY (+ optional ALERT_EMAIL) in .env / GitHub secrets
// In Resend test mode it emails the address you signed up with, from onboarding@resend.dev
// — zero domain setup. Inert if unconfigured; everything else runs normally.
// (Remote control / kill-switch is on the dashboard: the 🛑 KILL button, or POST /api/kill.)
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO = process.env.ALERT_EMAIL || 'ritvikrp07@gmail.com';
const FROM = process.env.ALERT_FROM || 'T212 Bot <onboarding@resend.dev>';

function start(bus) {
  bus.alertStatus = { enabled: !!RESEND_KEY, sent: 0, lastError: null, to: TO };
  if (!RESEND_KEY) { console.log('[alerts] email disabled — set RESEND_API_KEY (+ ALERT_EMAIL) for inbox alerts'); return; }

  async function email(subject, html) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
      });
      if (r.status >= 200 && r.status < 300) { bus.alertStatus.sent++; bus.alertStatus.lastError = null; }
      else { bus.alertStatus.lastError = 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 140); }
    } catch (e) { bus.alertStatus.lastError = e.message; }
  }
  bus.notify = (text) => email('T212 bot', `<p>${text}</p>`);

  // trade alerts — wrap the logger's onTrade hook (logger starts first)
  const prev = bus.onTrade;
  bus.onTrade = (h) => {
    if (prev) prev(h);
    const tag = h.action === 'BUY' ? '🟢 BUY' : (h.pnl >= 0 ? '✅ SELL' : '🔴 SELL');
    email(`${tag} ${h.sym}${h.pnl != null ? ` (${h.pnl >= 0 ? '+' : ''}${(+h.pnl).toFixed(2)})` : ''}`,
      `<h3>${tag} ${h.sym}</h3><p>${h.qty} @ ${h.price}` +
      (h.pnl != null ? `<br>P&amp;L: <b>${h.pnl >= 0 ? '+' : ''}${(+h.pnl).toFixed(2)}</b>` : '') +
      `</p><p><i>${String(h.why || '').slice(0, 220)}</i></p>`);
  };

  // critical state transitions → one email each on the flip
  let wasHalted = false, wasLock = false, wasDayPaused = false;
  setInterval(() => {
    const r = bus.riskStatus || {};
    if (r.halted && !wasHalted) email('⛔ HALTED + LIQUIDATED', `<p>${r.haltReason || ''}</p>`);
    if (r.dayProfitLock && !wasLock) email('🔒 Daily profit locked in', `<p>Up +${r.dayGain}% on the day — no new entries until tomorrow.</p>`);
    if (r.dayPaused && !wasDayPaused) email('⚠️ Daily loss breaker tripped', `<p>Entries paused until tomorrow.</p>`);
    wasHalted = !!r.halted; wasLock = !!r.dayProfitLock; wasDayPaused = !!r.dayPaused;
  }, 5000);

  setTimeout(() => email('🤖 T212 bot online',
    `<p><b>${bus.riskStatus?.live ? 'LIVE £ (real money)' : 'practice'}</b> / ${bus.riskStatus?.profile || '?'} profile<br>` +
    `universe ${bus.universe.length} · equity ${bus.riskStatus?.equity ?? '?'}</p>`), 6000);
  console.log('[alerts] email alerts armed → ' + TO);
}
module.exports = { start };
