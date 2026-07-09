'use strict';
// Builds the tradable universe. Fallback: curated 244 majors. Once T212 connects,
// expands to EVERY instrument tradable on the practice account that maps to a Yahoo
// data symbol. Venue suffix decoder (verified against the real instrument list):
//   _US_EQ → US   |  l_EQ → .L (London)  |  d_EQ → .DE (Xetra)   |  p_EQ → .PA (Paris)
//   a_EQ → .AS (Amsterdam) | m_EQ → .MI (Milan) | s_EQ → .SW (Zurich) | e_EQ → .MC (Madrid)
//   _CA_EQ → .TO (Toronto) | _AT_EQ → .VI (Vienna) | _BE_EQ/_BB_EQ → .BR (Brussels) | _PT_EQ → .LS (Lisbon)
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
  // worldwide expansion — ~780 more instruments T212 lists that were silently skipped
  [/^([A-Z0-9.]+)_CA_EQ$/, m => m[1].replace(/\./g, '-') + '.TO'],
  [/^([A-Z0-9.]+)_AT_EQ$/, m => m[1] + '.VI'],
  [/^([A-Z0-9.]+)_BE_EQ$/, m => m[1] + '.BR'],
  [/^([A-Z0-9.]+)_BB_EQ$/, m => m[1] + '.BR'],
  [/^([A-Z0-9.]+)_PT_EQ$/, m => m[1] + '.LS'],
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
    // gbx: T212 quotes this instrument in GBX pence — consumers must ÷100 its T212 prices
    out.push({ y, t212: it.ticker, name: it.name || it.shortName || y, gbx: it.currencyCode === 'GBX' });
  }
  return { universe: out, skipped };
}
function fallback() {
  return FALLBACK_UNIVERSE.map(y => ({ y, t212: null, name: (NAMES[y] || y.split('.')[0]) }));
}
module.exports = { fromInstruments, fallback };
