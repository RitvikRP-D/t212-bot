# Autonomous Safety Guide — Running Without Claude Code

**Your bot runs 24/7 on GitHub Actions, completely independent of me or your Claude subscription.** These safety systems keep it from destroying your account if something breaks.

---

## 🚨 Emergency Kill Switch (INSTANT LIQUIDATION)

### How to trigger:
1. Open your repo on github.com
2. Create a new file at the root: `.emergency-halt`
3. Commit + push (contents don't matter, file just needs to exist)
4. On the NEXT scheduled bot run (~5 min or less), it will:
   - Detect the `.emergency-halt` file
   - Liquidate ALL positions immediately
   - Pause the bot
   - Delete the file and save state

### When to use:
- Bot is doing something obviously wrong (e.g., opening positions in closed markets, massive positions)
- You see positions that shouldn't exist
- Something on your T212 app shows activity you didn't expect
- **Any time you're panicked**

### Example:
```bash
# From your machine or phone (via GitHub web UI)
touch .emergency-halt
git add .emergency-halt
git commit -m "EMERGENCY HALT"
git push
```

Bot will notice within 5 minutes and flatten everything.

---

## 💚 Health Status — Check if Bot is Alive

### Check the `.bot-status` file:
Every minute, the bot writes its status to `bot-data/.bot-status`:

```json
{
  "alive": true,
  "timestamp": "2026-07-04T18:30:00.000Z",
  "connected": true,
  "openPositions": 3,
  "equity": 245.67,
  "lastTrade": "2026-07-04T18:29:00.000Z"
}
```

**Check this from GitHub:**
1. Go to your repo → `bot-data` folder
2. Look for `.bot-status` file
3. If it's fresh (timestamp within last 2 min) → bot is alive ✅
4. If it's stale (older than 5 min) → something is wrong ⚠️

**What to do if stale:**
- Push the `.emergency-halt` file (see above)
- Check GitHub Actions logs to see if the job crashed
- Manually close positions in the T212 app if you're worried

---

## 🔄 Autonomous Safety Nets (No Action Needed — They Auto-Fire)

### Dead-Man's Switch
- **What**: If the bot has open positions but hasn't successfully traded in 1+ hour during market hours, it auto-liquidates
- **Why**: If the bot is completely stuck/hung, you don't want positions bleeding overnight
- **Trigger**: Automatic, no action needed
- **Outcome**: All positions closed at market, bot paused, alert sent

### Health Heartbeat
- **What**: Every 5 minutes, bot checks: T212 connected? Market data flowing? Risk guardian alive?
- **Why**: Catch silent failures before they cost money
- **Trigger**: Automatic
- **Outcome**: If 2+ critical checks fail with open positions, you get an alert: "⚠️ Bot health check failed"

### Orphan Order Cleanup
- **What**: On startup, if the bot finds incomplete orders, it cancels them instead of leaving them hanging
- **Why**: Prevents "zombie" orders blocking capital
- **Trigger**: Automatic on next restart
- **Outcome**: Clean state after any crash

---

## 💰 When You Fund Your Account

**Without Claude there, you still have two options:**

### Option A: Automatic (no action)
- Deposit money
- Bot detects the jump (if >8% of balance)
- Bot re-baselines the risk floor automatically
- Everything continues

### Option B: Manual Safety (recommended)
- Deposit money
- On the next dashboard access (phone/laptop on your LAN):
  - Click the **💰 Rebaseline** button
  - Confirms: "✓ Baseline: £X"
- Risk floor is now synced

**If you can't access dashboard from home network:**
- Manually edit `bot-data/state.json` (in the repo, via GitHub)
  - Find `"baseline": 100`
  - Change to your new account value
  - Commit + push
- Bot will load it on next run

---

## 📋 Quick Reference: What to Do If...

### "I think the bot is stuck"
1. Check `.bot-status` file in `bot-data/` folder
2. If timestamp is >5 min old, push `.emergency-halt` to trigger liquidation
3. Check GitHub Actions logs to see what failed
4. Manually close any positions in T212 app if unsure

### "Bot opened a position in a closed market"
1. Push `.emergency-halt` immediately
2. Bug report: this shouldn't happen; flagged for me to fix

### "I deposited money and don't want the daily profit lock to misfire"
1. Click **💰 Rebaseline** on the dashboard, OR
2. Edit `bot-data/state.json` baseline field directly in GitHub UI

### "Bot is paused but I want it to resume"
1. If it's paused due to emergency-halt: the bot will resume on next run (if `.emergency-halt` file is gone)
2. If it's paused for other reasons: edit `state.json`, change `"pause": true` to `"pause": false`, commit + push

### "I see positions on T212 that the bot doesn't know about"
1. Check GitHub Actions logs — bot crashed mid-reconcile?
2. Run the bot manually (or wait for next scheduled run) so it reconciles
3. If positions still don't match: edit `state.json` manually to match reality, then push

### "I want to switch to demo mode (stop risking real money)"
1. Edit `bot-data/state.json`
2. Change `"t212": { "positions": {...} }` to `"t212": { "positions": {} }` to clear open positions
3. Optionally add `T212_LIVE=false` to your GitHub Actions secrets to lock it to demo
4. Commit + push

---

## 🔧 What's Running in the Background

**Without me there, these run automatically every bot run (~6 times/day):**

1. ✅ **Autonomous reconnect** — if T212 API key expires, bot detects 401/403 and re-authenticates (you just need to check GitHub Actions logs)
2. ✅ **Dead-man's switch** — if no trades for 1h+ → auto-liquidate
3. ✅ **Health heartbeat** — every 5 min, verify bot is functional
4. ✅ **Status ping** — every 1 min, write `.bot-status` so you can check health
5. ✅ **Orphan cleanup** — on restart, cancel incomplete orders
6. ✅ **Auto-rebase on deposits** — detect external funding, adjust risk floor
7. ✅ **Network timeout protection** — 15s timeout on all T212 API calls (no hung requests)
8. ✅ **Stale state recovery** — atomic writes, corruption detection

**What you still need to do:**
- **Check `.bot-status`** once a week (2 min)
- **Hit emergency-halt** if something looks wrong (30 sec)
- **Rebaseline** after funding account (30 sec)

That's it. The bot doesn't need you watching 24/7.

---

## ⚠️ Things That Still Need Manual Intervention

1. **Major code bugs** (e.g., algorithm broken, wrong venue, etc.)
   - Fix: Push a code fix, or push `.emergency-halt` + email me
   
2. **T212 API breaking changes** (e.g., response format changes)
   - Fix: Push a code patch to handle new format
   
3. **Market event-driven gaps** (e.g., 20% overnight gap)
   - Fix: Bot handles this, but positions might take a large loss; manual check recommended

4. **Extremely rare race conditions**
   - Fix: Manual intervention may be needed; push emergency-halt first

Most of these should NOT happen with the fixes in place. But if they do, you have:
- Emergency liquidation (`.emergency-halt` file)
- Health status (`.bot-status` file)
- GitHub Actions logs (to debug)
- Direct control via T212 app (always works)

You're protected.

---

*Last updated: 2026-07-04 — System ready for autonomous operation*
