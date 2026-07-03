'use strict';
// AGENT ⑤: TradingView bridge — reads whichever chart is open in your TradingView
// Desktop app (via its debug port) and flags that symbol as priority for the scanner.
const { execFile } = require('child_process');
const TV_DIR = '/Users/ritvik_rp/Documents/Ritvik/RITVIK STOCKS/tradingview-mcp';
const NODE = process.execPath;

function start(bus) {
  bus.tvStatus = { connected: false, symbol: null, resolution: null, lastCheck: null };
  function poll() {
    execFile(NODE, ['src/cli/index.js', 'status'], { cwd: TV_DIR, timeout: 8000 }, (err, stdout) => {
      bus.tvStatus.lastCheck = new Date().toLocaleTimeString();
      if (err) { bus.tvStatus.connected = false; return; }
      try {
        const j = JSON.parse(stdout);
        bus.tvStatus.connected = !!j.cdp_connected;
        bus.tvStatus.symbol = j.chart_symbol || null;
        bus.tvStatus.resolution = j.chart_resolution || null;
        if (j.chart_symbol) {
          const base = j.chart_symbol.split(':').pop();
          for (const [sym, mk] of Object.entries(bus.market))
            mk.tvWatching = sym === base || sym.split('.')[0] === base;
        }
      } catch (e) { bus.tvStatus.connected = false; }
    });
  }
  poll();
  setInterval(poll, 20000);
  console.log('[tradingview] bridge started');
}
module.exports = { start };
