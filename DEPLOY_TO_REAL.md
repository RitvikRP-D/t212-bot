# Deployment Checklist: From Practice to Real Money (£100 Account)

**Follow this exact sequence.** Skipping steps WILL break the bot's risk calculations.

---

## Phase 1: Prep (Do this first, on practice account)

- [ ] Bot has been running on practice for at least 4+ hours
- [ ] You've verified all safety systems work (check logs, dashboard, etc.)
- [ ] All critical fixes are in place (syntax-verified, no crashes)
- [ ] You understand the autonomous safety features (read AUTONOMOUS_SAFETY.md)

---

## Phase 2: Clean State for Real Account

**CRITICAL**: You must reset the state file before switching to real money.

**Why:** The practice bot built up state with a £10,000 baseline. If you switch to real with that state, the risk floor will be wildly wrong (10% of £10,000 = £1,000, but you only have £100).

### Step 1: Stop the bot
- GitHub Actions will stop on its own schedule, OR
- Push `.emergency-halt` file to immediately halt

### Step 2: Reset state.json
Go to GitHub UI → `bot-data/state.json` → Edit:

**Find and clear these sections:**
```json
"t212": { "positions": {} },                    // clear any open positions
"realized": 0,                                   // clear accumulated trades
"history": [],                                   // clear trade log
"learn": {},                                     // clear learning history
"equityCurve": [],                               // clear equity curve
```

**Also reset risk state inside the file:**
```json
"risk": {
  "baseline": null,                              // IMPORTANT: set to null, not a number
  "halted": false,
  "day": null,
  "dayStart": null,
  "incidents": []
}
```

**After editing**, the key sections should look like:
```json
{
  "paper": { "balance": 10000, "positions": {} },
  "t212": { "positions": {} },
  "realized": 0,
  "history": [],
  "learn": {},
  "equityCurve": [],
  "pause": false,
  "risk": { "baseline": null, "halted": false, "day": null, "dayStart": null, "incidents": [] },
  "startedAt": "2026-07-04T...",
  "queue": {}
}
```

### Step 3: Commit the clean state
```bash
git add bot-data/state.json
git commit -m "Reset state for real account deployment"
git push
```

---

## Phase 3: Activate Real-Money Mode

### Step 1: Add T212 real-account credentials to GitHub Secrets

**You'll need TWO sets of API keys:**
- **Practice keys** (current): T212_API_KEY_ID, T212_API_SECRET (for demo.trading212.com)
- **Real keys** (new): Need to generate these in your T212 app for live.trading212.com

In the T212 mobile app:
1. Settings → API
2. Generate a NEW set of credentials for LIVE account
3. Copy the keyId and secret

In GitHub:
1. Go to Settings → Secrets and variables → Actions
2. Create two NEW secrets (or overwrite existing):
   - `T212_API_KEY_ID` = your LIVE key ID
   - `T212_API_SECRET` = your LIVE secret

### Step 2: Enable real-money mode

In GitHub Secrets, create:
- `T212_LIVE` = `true`

Now the bot will connect to `live.trading212.com` instead of demo.

### Step 3: Push this configuration
```bash
# (no files to commit, just the secrets are updated in GitHub UI)
# Bot will pick up secrets on next scheduled run
```

---

## Phase 4: Verify Live Deployment

**Wait for the next scheduled bot run (~5 min if you just pushed).**

### Check 1: Verify connection
- GitHub Actions → Latest run log
- Look for: `[t212] ⚠️ LIVE REAL-MONEY MODE — orders hit your real Trading212 account`
- Should NOT see: `[t212] practice mode — demo.trading212.com`

### Check 2: Verify baseline was set
- GitHub Actions log → look for: `[RISK] baseline set: 100.00 — hard floor 90.00`
- Should show your actual account value (£100 → floor £90)

### Check 3: Verify no account-mismatch alert
- If you see: `⚠️ ACCOUNT MISMATCH DETECTED`
- That means state.json still had old practice baseline
- **STOP** — push `.emergency-halt`, fix state, restart

### Check 4: Check bot-data/.bot-status
- Should show: `"connected": true`, `"equity": 100.00` (or your actual balance)
- If stale (>5 min old) or shows wrong equity → something is wrong, push `.emergency-halt`

---

## Phase 5: First Trading Window (Cautious)

**For the first 24 hours:**
- Monitor the bot actively (check logs every hour)
- Check `.bot-status` file
- Verify positions are opening/closing normally
- Check your T212 app to see if orders match what the logs say

**If anything looks weird:**
- Push `.emergency-halt` immediately
- Manually close positions in T212 app
- Review logs to see what went wrong
- Fix the bug before resuming

---

## If Something Goes Wrong

### "Bot opened a position in the real account but I didn't mean to"
1. Push `.emergency-halt` immediately (liquidates everything)
2. Close the position manually in T212 if needed
3. Review GitHub Actions logs to see why it happened

### "Baseline is wrong (shows £10,000 instead of £100)"
1. Push `.emergency-halt`
2. Edit `bot-data/state.json` manually in GitHub UI
3. Set `"baseline": null` to force a recalculation
4. Commit + push
5. Bot will recalculate on next run

### "Bot is paused and won't trade"
1. Check `.bot-status` file — is there an incident logged?
2. Edit `bot-data/state.json` in GitHub UI
3. Find `"pause": true`, change to `"pause": false`
4. Commit + push

### "I want to switch back to practice"
1. Unset or set `T212_LIVE=false` in GitHub Secrets
2. Bot will connect to demo on next run
3. Positions may diverge (it's demo, separate ledger) — that's expected

---

## Rollback to Practice (if needed)

1. Push `.emergency-halt` (to liquidate real positions)
2. Set `T212_LIVE=false` in GitHub Secrets (or delete the secret)
3. Reset `bot-data/state.json` to a clean state
4. Bot will resume on practice account

---

## Safety Checklist Before You Go Live

- [ ] State.json is reset (baseline: null, all positions cleared)
- [ ] Commit pushed to main branch
- [ ] T212_LIVE=true is set in GitHub Secrets
- [ ] Real-account API keys are set in GitHub Secrets
- [ ] First bot run shows `[t212] LIVE REAL-MONEY MODE` in logs
- [ ] First run shows baseline set to ~£100
- [ ] `.bot-status` file shows correct equity
- [ ] No account-mismatch alerts
- [ ] You've read AUTONOMOUS_SAFETY.md and know how to hit emergency-halt

---

## Once Live

1. **Check `.bot-status` once per week** (takes 1 min)
2. **Monitor first 24 hours actively** (check logs 2-3 times)
3. **After that**: Check monthly or after major code changes
4. **Know your kill switch**: `.emergency-halt` file, always works

---

**You're protected. Follow this checklist exactly and you won't have problems.**
