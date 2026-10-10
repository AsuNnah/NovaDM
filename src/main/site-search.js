'use strict';
// "Tab to search": type the start of a site's name in the address bar, press Tab, and what you
// type next is searched on that site.
const SITES = [
  { name: 'Google', keys: ['google'], url: 'https://www.google.com/search?q=%s' },
  { name: 'YouTube', keys: ['youtube', 'yt'], url: 'https://www.youtube.com/results?search_query=%s' },
  { name: 'Wikipedia', keys: ['wikipedia', 'wiki'], url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { name: 'GitHub', keys: ['github'], url: 'https://github.com/search?q=%s' },
  { name: 'DuckDuckGo', keys: ['duckduckgo', 'ddg'], url: 'https://duckduckgo.com/?q=%s' },
  { name: 'Bing', keys: ['bing'], url: 'https://www.bing.com/search?q=%s' },
  { name: 'Brave Search', keys: ['brave', 'search.brave'], url: 'https://search.brave.com/search?q=%s' },
  { name: 'Google Maps', keys: ['maps', 'gmaps'], url: 'https://www.google.com/maps/search/%s' },
  { name: 'Amazon', keys: ['amazon'], url: 'https://www.amazon.com/s?k=%s' },
  { name: 'Reddit', keys: ['reddit'], url: 'https://www.reddit.com/search/?q=%s' },
  { name: 'Stack Overflow', keys: ['stackoverflow', 'so'], url: 'https://stackoverflow.com/search?q=%s' },
  { name: 'npm', keys: ['npm', 'npmjs'], url: 'https://www.npmjs.com/search?q=%s' },
];

/** The site that `typed` names ("you", "youtube", "www.youtube.com"), or null. */
function siteFor(typed) {
  let t = String(typed || '').trim().toLowerCase();
  if (!t || /\s/.test(t)) return null;
  t = t.replace(/^[a-z]+:\/\//, '').replace(/^www\.|^en\./, '').replace(/\/.*$/, '');
  const word = t.replace(/\.(com|org|net|io|co)$/, '');
  if (word.length < 2) return null;
  // An exact key (yt, so) first; then the start of a name, but only from 3 letters ("go" is not Google).
  const s = SITES.find((x) => x.keys.includes(word)) || (word.length >= 3 && SITES.find((x) => x.keys.some((k) => k.startsWith(word))));
  return s ? { name: s.name, url: s.url } : null;
}

const searchUrl = (site, q) => site.url.replace('%s', encodeURIComponent(q));

module.exports = { siteFor, searchUrl, SITES };
