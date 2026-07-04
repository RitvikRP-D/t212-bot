'use strict';
// AGENT ⑱: EMAIL ALERTS — emails you on every trade, halt, daily profit-lock and loss-
// breaker, plus a startup ping. Two channels:
//   • formsubmit.co (DEFAULT, zero setup, no key) — you just click one "Activate" link the
//     first time; after that every alert lands in your inbox. Best for the low-volume real
//     account. Free but rate-limited, so heavy practice-day churn may drop some.
//   • Resend (set RESEND_API_KEY) — proper transactional email, fast + reliable. 3-min free
//     signup at resend.com. Recommended once you're live and want zero missed alerts.
// Disable entirely with EMAIL_ALERTS=off. Alerts go to ALERT_EMAIL (defaults to your Gmail).
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO = process.env.ALERT_EMAIL || 'ritvikrp07@gmail.com';
const FROM = process.env.ALERT_FROM || 'T212 Bot <onboarding@resend.dev>';
const CHANNEL = process.env.EMAIL_ALERTS === 'off' ? 'off' : (RESEND_KEY ? 'resend' : 'formsubmit');

function start(bus) {
  bus.alertStatus = { enabled: CHANNEL !== 'off', channel: CHANNEL, sent: 0, lastError: null, to: TO };
  if (CHANNEL === 'off') { console.log('[alerts] email off (EMAIL_ALERTS=off)'); return; }

  async function email(subject, text) {
    try {
      let r;
      if (CHANNEL === 'resend') {
        r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM, to: [TO], subject, html: `<pre style="font:14px monospace">${text}</pre>` }),
        });
      } else { // formsubmit.co — needs an Origin/Referer; first send triggers a one-time activation email
        r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(TO), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://t212bot.local', 'Referer': 'https://t212bot.local/' },
          body: JSON.stringify({ _subject: subject, message: text, _template: 'box' }),
        });
      }
      if (r.status >= 200 && r.status < 300) { bus.alertStatus.sent++; bus.alertStatus.lastError = null; }
      else { bus.alertStatus.lastError = 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120); }
    } catch (e) { bus.alertStatus.lastError = e.message; }
  }
  bus.notify = (t) => email('T212 bot', t);

  // trade alerts — wrap the logger's onTrade hook (logger starts first)
  const prev = bus.onTrade;
  bus.onTrade = (h) => {
    if (prev) prev(h);
    const mode = bus.riskStatus?.live ? 'LIVE £' : 'practice';
    const tag = h.action === 'BUY' ? 'BUY' : 'SELL';
    const pnl = h.pnl != null ? `\nP&L: ${h.pnl >= 0 ? '+' : ''}${(+h.pnl).toFixed(2)}` : '';
    email(`[${mode}] ${tag} ${h.sym}${h.pnl != null ? ` ${h.pnl >= 0 ? '+' : ''}${(+h.pnl).toFixed(2)}` : ''}`,
      `${tag} ${h.sym}\n${h.qty} @ ${h.price}${pnl}\n\n${String(h.why || '').slice(0, 300)}`);
  };

  // critical state transitions — one email each on the flip
  let wasHalted = false, wasLock = false, wasDayPaused = false;
  setInterval(() => {
    const r = bus.riskStatus || {};
    if (r.halted && !wasHalted) email('⛔ HALTED + LIQUIDATED', r.haltReason || 'max drawdown floor breached');
    if (r.dayProfitLock && !wasLock) email('🔒 Daily profit locked in', `Up +${r.dayGain}% on the day — no new entries until tomorrow.`);
    if (r.dayPaused && !wasDayPaused) email('⚠️ Daily loss breaker', 'Entries paused until tomorrow.');
    wasHalted = !!r.halted; wasLock = !!r.dayProfitLock; wasDayPaused = !!r.dayPaused;
  }, 5000);

  setTimeout(() => email('🤖 T212 bot online',
    `Mode: ${bus.riskStatus?.live ? 'LIVE £ (real money)' : 'practice'} / ${bus.riskStatus?.profile || '?'} profile\n` +
    `Universe: ${bus.universe.length}\nEquity: ${bus.riskStatus?.equity ?? '?'}\n\nYou'll get an email on every trade, halt and daily lock.`), 6000);
  console.log(`[alerts] email alerts armed via ${CHANNEL} → ${TO}`);
}
module.exports = { start };
