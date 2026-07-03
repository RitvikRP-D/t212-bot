'use strict';
// Builds the tradable universe. Fallback: curated 244 majors. Once T212 connects,
// expands to EVERY instrument tradable on your practice account that we can map
// to a Yahoo data symbol (US "_US_EQ" and London "…l_EQ" tickers).
const { FALLBACK_UNIVERSE, NAMES } = require('../config');

function fromInstruments(list) {
  const out = []; let skipped = 0;
  for (const it of list) {
    if (!it || !it.ticker || (it.type !== 'STOCK' && it.type !== 'ETF')) { skipped++; continue; }
    let y = null;
    let m;
    if ((m = it.ticker.match(/^([A-Z0-9.]+)_US_EQ$/))) y = m[1].replace(/\./g, '-');
    else if ((m = it.ticker.match(/^([A-Z0-9]+)l_EQ$/))) y = m[1] + '.L';
    if (!y) { skipped++; continue; }
    out.push({ y, t212: it.ticker, name: it.name || it.shortName || y });
  }
  return { universe: out, skipped };
}
function fallback() {
  return FALLBACK_UNIVERSE.map(y => ({ y, t212: null, name: (NAMES[y] || y.split('.')[0]) }));
}
module.exports = { fromInstruments, fallback };
