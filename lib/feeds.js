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

function stripTags(s) { return s.replace(/<[^>]*>/g, ' '); }

function parseItems(xml, limit) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const m = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    let t = m && m[1] ? decode(stripTags(m[1])) : '';
    // Titleless posts (Truth Social puts the post body in <description>) — fall
    // back to description/content so "what he actually said" comes through.
    if (!t || t.length <= 4 || /^\[?no title\]?/i.test(t)) {
      const d = b.match(/<(description|content(?::encoded)?|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/i);
      if (d && d[2]) t = decode(stripTags(d[2])).slice(0, 200);
    }
    // article LINK — RSS <link>URL</link> or Atom <link href="URL"/> (Google News uses <link>)
    let url = '';
    const lm = b.match(/<link[^>]*>(?:<!\[CDATA\[)?\s*(https?:\/\/[\s\S]*?)\s*(?:\]\]>)?<\/link>/i);
    if (lm && lm[1]) url = decode(stripTags(lm[1]));
    else { const la = b.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/i); if (la) url = la[1]; }
    if (t && t.length > 4) out.push({ title: t, url });
    if (out.length >= limit) break;
  }
  return out;
}

// fetch a feed → [{title, source}]
// Hard 12s timeout: on cloud hosts a blackholed connection never RSTs, and one
// hung fetch would stall every sequential caller forever (this is exactly what
// froze the news fleet on Railway — zero headlines while all 31 feeds were fine).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function fetchHeadlines(url, source, limit = 15) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: ac.signal, redirect: 'follow',
    });
    const xml = await r.text();
    return parseItems(xml, limit).map(it => ({ title: it.title, url: it.url || '', source }));
  } finally { clearTimeout(t); }
}

module.exports = { fetchHeadlines, parseItems, decode };
