# RITVIK CONTROL — The Complete System Record (A→Z)

*Everything built, broken, fixed, and learned. Last updated: 2026-07-09, late evening.*

---

## 1. What this is

An autonomous trading system of **44 agents** running 24/7 on Railway, trading a
Trading212 **practice** account (~£97) across **17,120 instruments on 12 exchanges**
(US, London, Toronto, Xetra, Paris, Amsterdam, Zurich, Milan, Madrid, Vienna,
Brussels, Lisbon), plus crypto ETPs and commodity ETCs. Live dashboard with 2-second
updates. Real money is hard-locked to a conservative profile that no setting can
override; the practice account runs a user-ordered max-variance profile.

- **Live bot + dashboard**: https://t212-bot-production.up.railway.app
- **Repo**: github.com/RitvikRP-D/t212-bot (branch `main`; deploy = `railway up`)
- **Trade log**: Google Sheet via webhook (rows stream automatically)
- **State**: Railway volume `t212-bot-volume` at `/app/bot-data` (state.json + instrument cache)

## 2. The 44 agents (by job)

**Decision core** — trader (entries/exits/reconcile), risk guardian (baseline, −50%
practice floor / −10% real floor, day breakers), allocator (overnight queue → fires at
the bell), perf monitor (win rate, profit factor, left-on-table, per-agent scorecard,
cool-offs), **coach** *(new: nightly self-improvement — grades the day, writes lessons,
tunes quickTake/spikeVol/trailGap within hard bounds)*.

**Market data** — scanner (Yahoo 1-min candles, junk-deprioritized rotation, SPY pinned
hot), tvanalyst (TradingView 122 metrics/name, buy+sell sweeps), cryptoscanner (Binance
5m×288), cryptoTV, commodities (futures→ETC fallback), historian (monthly data to 1927),
ranker (16k weekly grades), marketmap, regime, pine smith (Pine scripts), earnings.

**News fleet** — news radar (~750 channels), news brain (interprets → sector bias),
news correlator (headline→stock, chart-checked), livenews (FT/Guardian/BBC deep reads),
news bridge, base news agent (RSS + congress trades + F&G).

**Desks** — Trump desk (playbook of 4 years of his positions, speech/interview lane
weighted extra, scheduled-events pre-warming), 8 commodity desks, Goldman-style
screener, valuation, risk desk, earnings desk, portfolio, technicals, dividend, moat,
patterns, macro, quiver (dormant — key is paid).

**Flow & self-healing** — **flow agent** *(sector flow + relative strength: leaders in
hot sectors get boost+vote, cold laggards docked)*, medic (heartbeats 16 agents, wedge
→ clean restart), sentinel (state integrity + API health), heartbeat/fleet boards,
auditor (equity math vs T212 + dead-letter surfacing), logger (xlsx/csv/Sheet),
alerts (email), openbell (venue-open re-analysis).

## 3. How a trade happens (the full gauntlet)

1. Scanner/news/TV surface a candidate (news names jump the scan queue via hotExtra)
2. **Hard gates**: blacklist → news veto (≤−0.30 composite kills it; MIRRORED for the
   279 inverse ETPs in the bear lane) → data-health → stale-quote (>2 min = no trade) →
   20-min re-entry cooldown → 2-losses-today bench → sub-$2 US ban → TradingView veto
   (fresh SELL rating blocks)
3. **Confidence assembly**: technical signal × learning weight + TV (0.28) + **news
   composite (±0.30 — the loudest voice)** + historian + ranker + Pine + flow + desks +
   Trump + congress + regime/recovery multipliers + power-hours boost + midday/VWAP docks
4. **Momentum lanes** override: SPIKE (≥1.8% in 15 min on coach-tuned volume), ORB
   (first-15-min-high break), GAP (≥2.5% open gap on news; all-session on earnings day),
   CLOSE_RUN (last-hour, above VWAP, green day)
5. **Sizing**: cash × (base+slope×conf) × regime × vol-adjust × expectancy (rolling
   profit factor) × recovery, capped per-trade, £8 minimum, 15% cash always reserved
6. **Order**: marketable limit (max +0.3% slip), cash reserved synchronously, sector/
   country caps, liquidity floor (US 20k/min), earnings blackout, dead-letter cooldown
7. **Exits**: momentum trail (ride past +1% net, bank on 0.5%-off-peak or two red bars;
   0.3% past +3%), spike fast-cut −1%, stall exits, 90-min dead-money recycler, book
   hygiene, before-close banking, breakeven+ lock, TV STRONG-SELL exit, ladder (real),
   trailing/ATR stops — all guarded by sellInFlight so no duplicate sells

## 4. Every bug found and fixed (the honest list)

**Catastrophic class**
- **GBX pence (100×)**: Yahoo quotes LSE in pence; orders were sized 100× wrong and .L
  P&L mixed pence with pounds. Fixed at producers + reconcile ÷100 via per-instrument flag.
- **Inverted news signs**: two agents applied macro news with the sign backwards —
  war/rates/tariff/china/recession steered trades the wrong way; bullish AI/crypto/gold
  news generated bearish bias. Tables rewritten in one correlation convention.
- **Paper-ledger leak**: boot-window entries fell into a $10k virtual ledger and painted
  giant fake positions (the "£5,291 UNH"). Paper is now retired whenever T212 is connected.
- **Vanished Railway volume**: the persistent volume disappeared → every deploy wiped
  state/history/P&L/cache (the "universe 244" and resetting-stats incidents). Volume
  re-created + a 17k universe snapshot now ships inside the repo (boot-proof).
- **Queue poisoning** (earlier session): one failed API call permanently killed all
  future T212 calls. Result/queue promises separated.
- **IPv6 blackhole** (earlier session): Railway→T212 hung on AAAA; `ipv4first` fixed
  every "operation aborted".

**Money-flow class**
- Cash over-commit race (entries all sized on the same stale balance — the July-4
  £9,996 incident): synchronous reservation.
- Duplicate-sell race (reconcile cleared pendingFill mid-sell): separate sellInFlight flag.
- Deploy churn froze exits: hold-time clocks reset every restart → hygiene/recycler
  never fired → cash starved. Clocks now anchor to T212's initialFillDate.
- Recycler insta-dump (missing openedAt read as 999 minutes → dumped re-adopted
  positions on boot): requires real timestamps.
- /cash endpoint 429s for hours: per-endpoint backoff + /summary fallback.
- Dead-man switch liquidation loop on phantoms: throttled, phantom-aware, auto-resumes.

**Signal-quality class**
- TV analyst only fetched top-350 by rating — bearish flips were invisible, so the
  protective STRONG-SELL exit could never fire: added the sell-side sweep.
- Crypto "24h" change was actually 2h (1m×120 klines) → 5m×288.
- Stale TV boosts (no freshness gate) fed dead ratings into live orders: 30-min gates.
- Oil news never reached oil desks (key mismatch 'wti'≠'oil'): mapped.
- Frozen news served as fresh during feed outages: TTL prune runs every tick + lastFreshAt.
- Correlator silently dropped out-of-order news batches: publish-time stamps.
- Sentiment age-decay was a no-op (pubDate never parsed): parsed.
- Stale prior-session VWAP/volume survived the open (<21 bars): guarded.
- Mixed paper/real P&L falsely tripped the risk baseline: ledgers split.
- Allocator queue never expired (Friday conviction fired Monday): 18h TTL.
- Openbell hot-list injections wiped within 25s by tvanalyst: separate hotExtra channel.
- Medic "revive" was a no-op (no hooks registered anywhere): escalation to clean
  restart at 3× grace.
- State file shallow-merge crash on partial saves: self-healing re-seed.

## 5. What the losses actually were

Realized losses since the start have been **pennies of spread**, not strategy losses —
the visible "£2–3 loss" was: phantom paper positions (display bug, purged), unrealized
wiggle on open positions, spreads paid while the pence/sign/clock bugs were being found,
and one −£1.35 mispriced recycler exit (bug, fixed same hour). The account never had a
losing day bigger than ~1%.

## 6. The self-improvement loop (per the video's architecture)

- **Knowledge layer**: news radar / historian / ranker / instrument snapshot
- **Procedure layer**: 44 agents with bounded advisory weights
- **Evaluation layer**: perf monitor grades outcomes (win rate, PF, left-on-table,
  per-agent scorecard) — a separate grader from the agents being graded
- **Memory**: persistent state.learn (per-signal weights), state.coach.lessons
  (plain-language daily lessons), trade history with peak/exit telemetry
- **The closed loop**: coach reads the day's evidence nightly → writes lessons →
  adjusts quickTake/spikeVol/trailGap inside hard bounds → trader uses tuned values →
  backer-quality dock silences historically-losing voices → expectancy sizing scales
  stake to proven edge → learner reweights signal types continuously
- **Human review layer**: dashboard PAUSE/RESUME/KILL, manual close buttons, blacklist,
  and the unoverridable real-money conservative lock

## 7. Honest expectations (written once, kept forever)

No configuration of this or any system can *guarantee* £15 (or any amount) between an
open and a close; that outcome belongs to the market. What the system controls is edge
(entries filtered eight ways, news-first, momentum lanes), cost (capped slippage,
liquidity floors, spread-aware sizing), risk (per-trade caps, breakers, floors), and
learning speed (nightly tuning). The max-variance profile raises the odds of large
gains and large losses together — user-ordered, demo money only.

## 8. Operations

- Deploy: `cd t212-bot && railway up --detach` (avoid casual redeploys — every restart
  costs warm-up; markets-closed hours are the free window)
- Env: `TRADING_PROFILE=practice` (aggressive), `T212_LIVE=false`; live keys would need
  a real-account API key and flip both — the profile still locks conservative when live
- Dashboard: `/` (control), `/legacy` (old), `/api/state` (JSON), poll-based (Railway
  buffers SSE — do not re-add EventSource)
- Boot sequence: universe from volume cache or bundled snapshot (instant 17k) → T212
  connect → adopt real positions with true fill times → agents warm (~2 min)

## 9. Current goal

**Target equity £112.15** (baseline £97.15 + £15, set 2026-07-09 evening). Hourly
automated checks verify order flow, fix blockers, and report progress. Tonight's state:
~£97.1, book cleaned to 1 position + £89.85 cash, every repair live, fleet 43/43
healthy (44/44 with coach after next deploy). Next session: London 08:00.
