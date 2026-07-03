# t212-bot

Autonomous multi-agent trader for a **Trading212 PRACTICE account only** (`demo.trading212.com` is hard-coded — real-money accounts are unreachable by design).

Agents: market scanner (1-min candles, ~11k instruments), news + congressional-trades sentiment, trader (confidence-sized entries, adaptive/trailing exits, self-learning), logger (Google Sheets webhook + CSV + XLSX), TradingView bridge (local only).

## Cloud (GitHub Actions)
`.github/workflows/trade.yml` runs the bot on weekdays in three chained windows covering London open → US close. State persists between runs via the Actions cache, and open positions are additionally recovered directly from the T212 account on every start.

Required repo **Secrets** (Settings → Secrets and variables → Actions):
- `T212_API_KEY_ID`, `T212_API_SECRET` — practice-account API key
- `GSHEET_WEBHOOK` — Apps Script web-app URL for the live Google Sheet log

Notes:
- In winter (after clocks change) the last ~30 min of the US session fall outside the scheduled window — widen the crons if that matters.
- US market holidays are not modeled; the bot just idles on stale candles.
- Monitoring while running in the cloud: the Google Sheet ("Trades" + "Summary" tabs) and the Trading212 app itself.

## Local
`node server.js` → dashboard at http://localhost:3100 (do **not** run locally while the cloud schedule is active — two bots would trade the same account).
