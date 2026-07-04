'use strict';
// AGENT ⑱: TELEGRAM — phone alerts + remote control (essential once real money runs
// while you sleep). Pings you on every trade, halt, daily profit-lock and loss-breaker,
// and takes commands: /status /positions /pause /resume /kill /help.
// Free: message @BotFather → /newbot → get the TOKEN; message your bot once, then read
// the chat id. Put TELEGRAM_TOKEN + TELEGRAM_CHAT in .env (or GitHub secrets). If unset,
// this agent is inert — everything else runs normally.
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT;

function start(bus) {
  bus.tgStatus = { enabled: !!(TOKEN && CHAT), sent: 0, lastCmd: null };
  if (!TOKEN || !CHAT) { console.log('[telegram] disabled — set TELEGRAM_TOKEN + TELEGRAM_CHAT for phone alerts/control'); return; }

  const api = (m, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function send(text) { try { await api('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }); bus.tgStatus.sent++; } catch (e) {} }
  bus.notify = send;   // any agent can call bus.notify('…')

  // wrap the trade hook (logger set it first) → alert on every entry/exit
  const prev = bus.onTrade;
  bus.onTrade = (h) => {
    if (prev) prev(h);
    const emo = h.action === 'BUY' ? '🟢' : (h.pnl >= 0 ? '✅' : '🔴');
    send(`${emo} <b>${h.action} ${h.sym}</b>\n${h.qty} @ ${h.price}` +
      (h.pnl != null ? `\nP&L: <b>${h.pnl >= 0 ? '+' : ''}${(+h.pnl).toFixed(2)}</b>` : '') +
      `\n<i>${String(h.why || '').slice(0, 140)}</i>`);
  };

  // watch for critical state transitions (halt / daily lock / loss breaker)
  let wasHalted = false, wasLock = false, wasDayPaused = false;
  setInterval(() => {
    const r = bus.riskStatus || {};
    if (r.halted && !wasHalted) send(`⛔ <b>HALTED + LIQUIDATED</b>\n${r.haltReason || ''}`);
    if (r.dayProfitLock && !wasLock) send(`🔒 <b>Daily profit locked in</b> (+${r.dayGain}%) — no new entries today.`);
    if (r.dayPaused && !wasDayPaused) send(`⚠️ <b>Daily loss breaker</b> — entries paused until tomorrow.`);
    wasHalted = !!r.halted; wasLock = !!r.dayProfitLock; wasDayPaused = !!r.dayPaused;
  }, 5000);

  const posLine = () => {
    const ps = Object.entries(bus.state.t212.positions);
    if (!ps.length) return 'no open positions';
    return ps.map(([s, p]) => { const px = bus.market[s]?.price || p.entry; const g = ((px - p.entry) / p.entry * 100).toFixed(2); return `${s}: ${g >= 0 ? '+' : ''}${g}% (${p.qty}@${p.entry})`; }).join('\n');
  };

  async function handle(cmd) {
    const r = bus.riskStatus || {};
    if (cmd === '/status' || cmd === '/s') {
      send(`📊 <b>Status</b>\nmode: ${r.live ? 'LIVE £' : 'practice'} / ${r.profile}\nequity: ${r.equity} (baseline ${r.baseline}, floor ${r.floor})\nday: ${r.dayGain || 0}%${r.dayProfitLock ? ' 🔒' : ''}${r.halted ? '\n⛔ HALTED: ' + r.haltReason : ''}${bus.state.pause ? '\n⏸ paused' : ''}\nopen: ${Object.keys(bus.state.t212.positions).length} · universe ${bus.universe.length} · markets open ${bus.scanStatus?.openNow ?? 0}`);
    } else if (cmd === '/positions' || cmd === '/p') { send('📈 <b>Positions</b>\n' + posLine());
    } else if (cmd === '/pause') { bus.state.pause = true; bus.markDirty(); send('⏸ Paused — no new entries. Send /resume to unpause.');
    } else if (cmd === '/resume') { bus.state.pause = false; bus.markDirty(); send('▶️ Resumed.');
    } else if (cmd === '/kill') {
      send('🛑 <b>KILL</b> — pausing + liquidating all positions at market.');
      bus.state.pause = true; bus.markDirty();
      if (bus.liquidateAll) await bus.liquidateAll('manual kill switch (Telegram)');
    } else if (cmd === '/help' || cmd === '/start') { send('Commands:\n/status · /positions · /pause · /resume · /kill'); }
  }

  let offset = 0;
  async function poll() {
    try {
      const j = await (await api('getUpdates', { offset, timeout: 0 })).json();
      for (const u of (j.result || [])) {
        offset = u.update_id + 1;
        const msg = u.message; if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(CHAT)) continue;   // only the owner can command
        const cmd = msg.text.trim().toLowerCase().split(/\s+/)[0];
        bus.tgStatus.lastCmd = cmd;
        await handle(cmd);
      }
    } catch (e) {}
  }
  setTimeout(() => send(`🤖 <b>Bot online</b> — ${bus.riskStatus?.live ? 'LIVE £' : 'practice'} / ${bus.riskStatus?.profile || '?'}\nuniverse ${bus.universe.length}, equity ${bus.riskStatus?.equity ?? '?'}`), 6000);
  setInterval(poll, 4000);
  console.log('[telegram] phone alerts + remote control armed (/status /kill …)');
}
module.exports = { start };
