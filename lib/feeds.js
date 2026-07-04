'use strict';
// Robust RSS/Atom reader. Parses titles ONLY from inside <item>/<entry> blocks,
// so channel titles and <image><title> blocks never leak in as fake headlines
// (the old "skip first <title>" trick failed on feeds with an image block).

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (e) { return ''; } })
    .replace(/&\w+;/g, m => ENT[m] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItems(xml, limit) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const m = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    if (m && m[1]) {
      const t = decode(m[1]);
      if (t && t.length > 4) out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// fetch a feed → [{title, source}]
async function fetchHeadlines(url, source, limit = 15) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research)' } });
  const xml = await r.text();
  return parseItems(xml, limit).map(title => ({ title, source }));
}

module.exports = { fetchHeadlines, parseItems, decode };
