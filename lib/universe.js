'use strict';
// Builds the tradable universe. Fallback: curated 244 majors. Once T212 connects,
// expands to EVERY instrument tradable on the practice account that maps to a Yahoo
// data symbol. Venue suffix decoder (verified against the real instrument list):
//   _US_EQ → US   |  l_EQ → .L (London)  |  d_EQ → .DE (Xetra)   |  p_EQ → .PA (Paris)
//   a_EQ → .AS (Amsterdam) | m_EQ → .MI (Milan) | s_EQ → .SW (Zurich) | e_EQ → .MC (Madrid)
const { FALLBACK_UNIVERSE, NAMES } = require('../config');

const VENUES = [
  [/^([A-Z0-9.]+)_US_EQ$/, m => m[1].replace(/\./g, '-')],
  [/^([A-Z0-9.]+)l_EQ$/, m => m[1].replace(/\./g, '-') + '.L'],
  [/^([A-Z0-9.]+)d_EQ$/, m => m[1] + '.DE'],
  [/^([A-Z0-9.]+)p_EQ$/, m => m[1] + '.PA'],
  [/^([A-Z0-9.]+)a_EQ$/, m => m[1] + '.AS'],
  [/^([A-Z0-9.]+)m_EQ$/, m => m[1] + '.MI'],
  [/^([A-Z0-9.]+)s_EQ$/, m => m[1] + '.SW'],
  [/^([A-Z0-9.]+)e_EQ$/, m => m[1] + '.MC'],
];

function fromInstruments(list) {
  const out = []; const seen = new Set(); let skipped = 0;
  for (const it of list) {
    if (!it || !it.ticker || (it.type !== 'STOCK' && it.type !== 'ETF')) { skipped++; continue; }
    let y = null;
    for (const [re, conv] of VENUES) {
      const m = it.ticker.match(re);
      if (m) { y = conv(m); break; }
    }
    if (!y || seen.has(y)) { skipped++; continue; }
    seen.add(y);
    out.push({ y, t212: it.ticker, name: it.name || it.shortName || y });
  }
  return { universe: out, skipped };
}
function fallback() {
  return FALLBACK_UNIVERSE.map(y => ({ y, t212: null, name: (NAMES[y] || y.split('.')[0]) }));
}
module.exports = { fromInstruments, fallback };
