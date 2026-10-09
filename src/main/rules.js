'use strict';
// User rules applied when a download is added:
//  - category rules: by file type, site or address text -> a category and/or a folder of its own
//    (settings.categoryRules: [{ by: 'type' | 'site' | 'text', value, category, folder }])
//  - per-site settings: connections, user agent, speed limit and a sign-in for one site
//    (settings.siteSettings: [{ site, connections, userAgent, speedLimitKBps, user, passEnc }])
const { extOf, hostOf } = require('./util');

const CATEGORIES = ['video', 'music', 'images', 'documents', 'archives', 'programs', 'other'];

function siteMatches(pattern, host) {
  const p = String(pattern || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return !!p && !!host && (host === p || host.endsWith('.' + p));
}

/** The first category rule that fits this download: { category, folder } (either may be empty). */
function categoryFor(rules, { url = '', name = '' }) {
  const host = hostOf(url);
  const ext = extOf(name) || extOf(String(url).split(/[?#]/)[0]);
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || !r.value) continue;
    const vals = String(r.value).toLowerCase().split(/[\s,;]+/).map((x) => x.replace(/^\./, '')).filter(Boolean);
    const hit = r.by === 'type' ? vals.includes(ext)
      : r.by === 'site' ? vals.some((v) => siteMatches(v, host))
      : r.by === 'text' ? vals.some((v) => String(url).toLowerCase().includes(v) || String(name).toLowerCase().includes(v))
      : false;
    if (hit) return { category: CATEGORIES.includes(r.category) ? r.category : '', folder: typeof r.folder === 'string' ? r.folder.trim() : '' };
  }
  return { category: '', folder: '' };
}

/** Per-site settings for a URL, or null. */
function siteSettingsFor(list, url) {
  const host = hostOf(url);
  return (Array.isArray(list) ? list : []).find((s) => s && siteMatches(s.site, host)) || null;
}

module.exports = { categoryFor, siteSettingsFor, siteMatches, CATEGORIES };
