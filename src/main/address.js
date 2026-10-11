'use strict';
// What the address bar and extensions hand to a tab -> the address it opens.
const NEWTAB = 'novadm://newtab';

function normalizeUrl(input, settings) {
  let s = String(input || '').trim();
  if (!s) return NEWTAB;
  if (s.startsWith('novadm://') || s.startsWith('about:') || /^view-source:https?:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return s;
  if (/^chrome-extension:\/\/[a-p]{32}(\/|$)/.test(s)) return s; // an extension's own page (options, welcome)
  // A single token with a dot and no spaces is treated as a domain; otherwise search.
  const looksDomain = /^[^\s]+\.[^\s]{2,}(\/|$|:)/.test(s) || s.startsWith('localhost');
  if (looksDomain && !s.includes(' ')) return 'https://' + s;
  return settings.searchUrl(s);
}

module.exports = { normalizeUrl, NEWTAB };
