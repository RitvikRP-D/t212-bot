'use strict';
// AGENT: FLEET BOARD — the "what is every single agent doing right now" view.
// It doesn't do trading work; it INTROSPECTS the whole fleet and publishes one live
// line per agent (grouped) so the dashboard can show all ~45 brains ticking in real
// time, on either account. "Doing" text is derived from each agent's own live output,
// so if the text is moving, that agent is provably alive. Age comes from bus.beats for
// agents that heartbeat; others are alive when their board has fresh data.
function start(bus) {
  const n = v => (v == null ? '—' : v);
  const t = (obj, k) => (obj && obj[k] != null ? obj[k] : null);

  // registry: [group, name, doing(bus)->string|null]. null string == idle/warming.
  const REG = [
    // ── MARKET DATA ──
    ['Data', 'scanner', b => b.scanStatus && `scanning ${n(b.scanStatus.scanned)}/${n(b.universe && b.universe.length)} names · last ${n(b.scanStatus.lastSym)}`],
    ['Data', 'crypto', b => b.cryptoStatus && `${n(b.cryptoStatus.coins)} coins on Binance · ${n(b.cryptoStatus.etpsMapped)} ETPs mapped · last ${n(b.cryptoStatus.lastSym)}`],
    ['Data', 'commodities', b => b.commodStatus && `${n(b.commodStatus.tracked || b.commodStatus.coins || 'gold/oil/metals')} tracked · last ${n(b.commodStatus.lastSym)}`],
    ['Data', 'historian', b => b.histStatus && `century data: ${n(b.histStatus.analyzed)} analysed · last ${n(b.histStatus.lastSym)}`],
    ['Data', 'ranker', b => b.rankStatus && `universe leaderboard: ${n(b.rankStatus.ranked || b.rankStatus.scored)} ranked`],
    ['Data', 'marketmap', b => b.marketMap && `venues: ${Object.entries(b.marketMap).filter(([, v]) => v && v.open).map(([k]) => k).join(',') || 'all closed'}`],
    // ── ANALYSIS ──
    ['Analysis', 'tv-stocks', b => b.tvaStatus && `TradingView: ${n(b.tvaStatus.rated)} names rated across 8 markets`],
    ['Analysis', 'tv-crypto', b => b.ctvStatus && `TradingView crypto: ${n(b.ctvStatus.rated)} coins · ${n(b.ctvStatus.totalMetrics)} metrics`],
    ['Analysis', 'fundamentals', b => b.fundStatus && `P/E·growth·debt·yield for ${n(b.fundStatus.names)} names (${n(b.fundStatus.cols)} cols)`],
    ['Analysis', 'regime', b => b.regime && `tape regime: ${n(b.regime.state)}${b.regime.mult ? ` · conf×${b.regime.mult.conf}` : ''}`],
    ['Analysis', 'pine', b => b.pineStatus && `Pine v5 confluence: ${n(b.pineStatus.evaluated || b.pineStatus.scanned)} scanned`],
    ['Analysis', 'earnings', b => b.earnings && `earnings blackout calendar: ${n(b.earnings.count)} upcoming`],
    // ── NEWS ──
    ['News', 'news-radar', b => b.newsRadar && `${n(b.newsRadar.sources)}/${n(b.newsRadar.channels)} channels live · ${n(b.newsRadar.total)} stories · +${n(b.newsRadar.perTick)} this tick`],
    ['News', 'news-brain', b => b.newsBrain && b.newsBrain.top && `interpreting: ${n(b.newsBrain.top.length)} names leaned · ${n((b.newsBrain.sectors || []).length)} sectors tilted`],
    ['News', 'news-correlate', b => b.newsCorrStatus && `${n(b.newsCorrStatus.active)} live correlations · ${n(b.newsCorrStatus.withTV)} chart-checked`],
    ['News', 'news-bridge', b => b.newsBridge && `feeding trader: ${n((b.newsBridge.aligned || []).length)} aligned · ${n((b.newsBridge.conflicts || []).length)} conflicts`],
    ['News', 'market-news', b => b.news && `FNG ${n(b.news.fng && b.news.fng.value)} · ${n((b.news.headlines || []).length)} headlines · ${n((b.news.congress || []).length)} congress`],
    ['News', 'deep-news', b => b.deepNews && `${n(b.deepNews.sources)} deep desks · mood ${n(b.deepNews.global)}`],
    ['News', 'crypto-news', b => b.cryptoNews && `crypto desk: mood ${n(b.cryptoNews.global)}`],
    ['News', 'open-bell', b => b.openBell && `last venue open: ${n(b.openBell.lastOpened && (b.openBell.lastOpened.label || b.openBell.lastOpened.venue))}`],
    ['News', 'trump-desk', b => b.trump && `${(b.trump.owns || []).length} linked equities · ${Object.values(b.trump.policyThemes || {}).filter(v => v > 0.3).length} policy themes hot · ${(b.trump.congressBuys || []).length} congress buys`],
    ['News', 'quiver', b => b.quiver && (b.quiver.enabled ? `ACTIVE · ${(b.quiver.congress || []).length} congress · ${(b.quiver.contracts || []).length} gov contracts` : 'dormant (needs QUIVER_API_KEY)')],
    // ── 10 INSTITUTIONAL DESKS ──
    ...[['screener', 'Goldman screener'], ['valuation', 'MS DCF'], ['risk', 'Bridgewater risk'], ['earnings', 'JPM earnings'],
        ['portfolio', 'BlackRock portfolio'], ['tech', 'Citadel technicals'], ['dividend', 'Harvard dividend'],
        ['moat', 'Bain moat'], ['patterns', 'RenTech patterns'], ['macro', 'McKinsey macro']]
      .map(([k, label]) => ['Desks', 'desk·' + k, b => b.desks && b.desks[k] && `${label} · updated ${n(b.desks[k].updated)}`]),
    // ── EXECUTION ──
    ['Execution', 'trader', b => `orders: ${Object.keys((b.state && b.state.t212.positions) || {}).length} open · beat ${age(b, 'trader')}`],
    ['Execution', 'allocator', b => b.allocStatus && `overnight queue: ${n(b.allocStatus.queued)} armed`],
    ['Execution', 'logger', b => b.logStatus && `log: ${n(b.logStatus.rows || b.logStatus.trades)} rows`],
    ['Execution', 'alerts', b => b.alertStatus && `email alerts: ${n(b.alertStatus.sent)} sent`],
    // ── RISK & OPS ──
    ['Risk/Ops', 'risk-guardian', b => b.riskStatus && `equity £${n(b.riskStatus.equity)} · floor £${n(b.riskStatus.floor)}${b.riskStatus.halted ? ' · HALTED' : ' · ok'}`],
    ['Risk/Ops', 'medic', b => b.medicStatus && `self-heal: ${n(b.medicStatus.restarts || 0)} restarts · ${n(b.medicStatus.status || 'watching')}`],
    ['Risk/Ops', 'sentinel', b => b.sentinelStatus && `integrity checks: ${n(b.sentinelStatus.checks || b.sentinelStatus.status || 'watching')}`],
    ['Risk/Ops', 'auditor', b => b.audit && `execution audit: ${n(b.audit.status || (b.audit.issues || []).length + ' issues')}`],
    ['Risk/Ops', 'perf', b => b.perf && `scorecard: ${n(b.perf.trades || b.perf.closed)} trades scored`],
    ['Risk/Ops', 'heartbeat', b => b.fleetProbe && `liveness: ${n((b.fleetProbe.silent || []).length)} silent`],
  ];

  function age(b, name) {
    const ms = b.beats && b.beats[name];
    if (!ms) return 'n/a';
    const s = Math.round((Date.now() - ms) / 1000);
    return s + 's';
  }

    // one-line plain-English JOB for each agent (what it's FOR), shown on the dashboard
    // next to its live activity so the fleet page actually means something.
    const DESC = {
      'scanner': 'Scans all ~16k instruments every minute for entry setups',
      'crypto': 'Scans 50 coins on Binance 1-min data + maps them to T212 ETPs',
      'commodities': 'Tracks gold/silver/oil/copper etc. via futures + ETC mapping',
      'historian': 'Reads each name\'s history back to 1927 for the long-term trend',
      'ranker': 'Grades the whole universe into a conviction leaderboard',
      'marketmap': 'Knows which venues (London/US/Asia…) are open right now',
      'tv-stocks': 'Pulls 122 TradingView metrics/name across 8 stock markets',
      'tv-crypto': 'Pulls multi-timeframe TradingView ratings for every coin',
      'fundamentals': 'Fetches P/E, growth, debt, margins, yields for ~6k names',
      'regime': 'Reads the tape regime (trend/chop/shock) + volatility',
      'pine': 'Generates a Pine v5 script per name + confluence score',
      'earnings': 'Tracks the earnings calendar so it can avoid report-day risk',
      'news-radar': 'Sweeps ~690 world news channels 24/7 for anything market-moving',
      'news-brain': 'Reads the news and says what it means + which sectors move',
      'news-correlate': 'Maps every headline to the exact stocks it hits + direction',
      'news-bridge': 'Feeds the interpreted news into the trader\'s vote',
      'market-news': 'Fear&Greed + headlines + congressional trades feed',
      'deep-news': 'Deep-reads the serious financial press (FT/Economist/Bloomberg)',
      'crypto-news': 'Dedicated crypto news desk + per-coin sentiment',
      'open-bell': 'Re-analyses everything the instant a market opens',
      'trump-desk': 'Tracks Trump-linked stocks, his posts + policy → tradeable signal',
      'quiver': 'Congress trades + gov contracts (Quiver, when a key is active)',
      'desk·screener': 'Goldman-style quality+value screen of the whole market',
      'desk·valuation': 'Morgan-Stanley-style DCF fair-value on holdings + picks',
      'desk·risk': 'Bridgewater-style portfolio risk: correlation, concentration, stress',
      'desk·earnings': 'JPMorgan-style pre-earnings briefs on names reporting soon',
      'desk·portfolio': 'BlackRock-style target allocation for your account size',
      'desk·tech': 'Citadel-style technical trade plans (support/resistance/targets)',
      'desk·dividend': 'Harvard-endowment-style income/dividend-safety screen',
      'desk·moat': 'Bain-style competitive-moat analysis by sector',
      'desk·patterns': 'RenTech-style statistical-edge memos from history + tape',
      'desk·macro': 'McKinsey-style macro → sector over/underweight calls',
      'trader': 'Places + manages the actual T212 orders on a 50-agent consensus',
      'allocator': 'Queues high-conviction ideas overnight to fire at the bell',
      'logger': 'Logs every trade to xlsx/csv/Google Sheet',
      'alerts': 'Emails you on fills and risk events',
      'risk-guardian': 'Enforces the 10% floor, daily breaker + auto-baseline',
      'medic': 'Self-heals the fleet + restarts on crashes',
      'sentinel': 'Constant integrity checks + auto-repair',
      'auditor': 'Audits every execution for slippage/errors',
      'perf': 'Scores which agents\' votes actually preceded winners',
      'heartbeat': 'Watches that every critical agent is still ticking',
    };

  function cycle() {
    const agents = [];
    for (const [group, name, fn] of REG) {
      let doing = null;
      try { doing = fn(bus); } catch (e) { doing = null; }
      agents.push({ group, name, desc: DESC[name] || '', doing: doing || 'warming up…', alive: !!doing });
    }
    const healthy = agents.filter(a => a.alive).length;
    bus.fleet = { agents, groups: [...new Set(agents.map(a => a.group))], healthy, total: agents.length, updated: new Date().toLocaleTimeString() };
  }
  setInterval(cycle, 4000);
  setTimeout(cycle, 8000);
  console.log(`[fleet] live agent board armed — introspecting ${REG.length} agents across 6 groups`);
}
module.exports = { start };
