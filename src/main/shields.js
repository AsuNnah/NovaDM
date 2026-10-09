'use strict';
// Navigation shortcuts in the style of Brave's Shields: less work and fewer trackers per page.
//  - debounce: skip known tracking redirect pages (google.com/url?q=…) and go straight to the target
//  - tracking parameters: drop click identifiers (fbclid, gclid…) from addresses
//  - de-AMP: open the publisher's page instead of the Google AMP cache copy
//  - HTTPS upgrade: open http:// links over HTTPS, falling back to http:// for sites without it
// The rules are NovaDM's own; only main-frame (and frame) navigations are rewritten.

// Redirect pages: host (exact or *.suffix), path test, and the parameter that holds the target.
const DEBOUNCE_RULES = [
  { host: /^(www\.)?google\.[a-z.]{2,6}$/, path: /^\/url$/, params: ['q', 'url'] },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.instagram\.com$/, path: /^\/$/, params: ['u'] },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
  { host: /^out\.reddit\.com$/, path: /./, params: ['url'] },
  { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, params: ['u', 'url'] },
  { host: /^t\.umblr\.com$/, path: /^\/redirect$/, params: ['z'] },
  { host: /^slack-redir\.net$/, path: /^\/link$/, params: ['url'] },
  { host: /^away\.vk\.com$/, path: /^\/away\.php$/, params: ['to'] },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/redir\/redirect\/?$/, params: ['url'] },
  { host: /^duckduckgo\.com$/, path: /^\/l\/?$/, params: ['uddg'] },
  { host: /^exit\.sc$/, path: /^\/$/, params: ['url'] },
  { host: /^(www\.)?deviantart\.com$/, path: /^\/users\/outgoing$/, query: true },
  { host: /^href\.li$/, path: /^\/$/, query: true },
  { host: /^(www\.)?bing\.com$/, path: /^\/ck\/a$/, params: ['u'], bing: true },
];

// Click and mail identifiers that only serve to track (campaign names like utm_* are left alone).
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'igsh', 'mc_eid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking',
  'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'vero_id', 'wickedid', 'ml_subscriber',
  'ml_subscriber_hash', 'srsltid', 'epik', 'sc_cid', 'li_fat_id', 'ck_subscriber_id',
]);

function parse(u) { try { return new URL(u); } catch { return null; } }
const isWeb = (u) => !!u && (u.protocol === 'http:' || u.protocol === 'https:');

/** The real destination of a known tracking redirect, or null. */
function debounce(url) {
  const u = parse(url);
  if (!isWeb(u)) return null;
  const host = u.hostname.toLowerCase();
  for (const r of DEBOUNCE_RULES) {
    if (!r.host.test(host) || !r.path.test(u.pathname)) continue;
    let target = '';
    if (r.query) target = decodeURIComponent(u.search.slice(1));
    else for (const p of r.params) { const v = u.searchParams.get(p); if (v) { target = v; break; } }
    if (r.bing && target.startsWith('a1')) {
      try { target = Buffer.from(target.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { target = ''; }
    }
    const t = parse(target);
    if (isWeb(t) && t.href !== u.href) return t.href;
    return null;
  }
  return null;
}

/** The address without click identifiers, or null if there were none. */
function stripTrackingParams(url) {
  const u = parse(url);
  if (!isWeb(u) || !u.search) return null;
  let removed = false;
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) { u.searchParams.delete(k); removed = true; }
  }
  if (!removed) return null;
  let out = u.href;
  if (!u.searchParams.toString()) out = out.replace('?', '');
  return out;
}

/** The publisher's address for a Google AMP cache / viewer address, or null. */
function deAmpUrl(url) {
  const u = parse(url);
  if (!isWeb(u)) return null;
  const host = u.hostname.toLowerCase();
  let rest = null;
  // https://www.google.com/amp/s/example.com/story  (s = https)
  if (/^(www\.)?google\.[a-z.]{2,6}$/.test(host)) {
    const m = /^\/amp\/(s\/)?(.+)$/.exec(u.pathname);
    if (m) rest = (m[1] ? 'https://' : 'http://') + m[2];
  }
  // https://example-com.cdn.ampproject.org/c/s/example.com/story
  if (host.endsWith('.cdn.ampproject.org')) {
    const m = /^\/[a-z]{1,2}\/(?:[a-z]{1,2}\/)*?(s\/)?([^/]+\..+)$/.exec(u.pathname);
    if (m) rest = (m[1] ? 'https://' : 'http://') + m[2];
  }
  if (!rest) return null;
  const t = parse(rest + u.search);
  return isWeb(t) ? t.href : null;
}

/** True for hosts that should stay on plain http (this computer, the local network, test names). */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || !h.includes('.') && !h.includes(':')) return true; // single-label names (intranet)
  if (/\.(local|localhost|test|internal|lan|home|corp|onion|i2p)$/.test(h) || h === 'localhost') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true; // IP addresses: no certificate for them
  if (h.includes(':')) return true; // IPv6 literal
  return false;
}

class Shields {
  constructor(settings) {
    this.settings = settings;
    this.httpOnly = new Set(); // hosts that failed over HTTPS this session
    this.upgraded = new Map(); // https url -> original http url (to fall back)
    this.recent = new Map(); // http url -> when it was last upgraded
    this.stats = { debounced: 0, stripped: 0, deAmp: 0, upgraded: 0 };
  }

  /**
   * A new page or frame is about to load: the address to go to instead, or null.
   * `isMain` is false for frames (only tracking parameters are removed there).
   */
  rewrite(url, { isMain = true } = {}) {
    const s = (k) => this.settings.get(k) !== false;
    if (isMain && s('debounceLinks')) {
      const d = debounce(url);
      if (d) { this.stats.debounced++; return this.rewrite(d, { isMain }) || d; }
    }
    if (isMain && s('deAmp')) {
      const d = deAmpUrl(url);
      if (d) { this.stats.deAmp++; return this.rewrite(d, { isMain }) || d; }
    }
    if (s('stripTrackingParams')) {
      const d = stripTrackingParams(url);
      if (d) { this.stats.stripped++; return this.rewrite(d, { isMain }) || d; }
    }
    if (isMain && s('httpsUpgrade')) {
      const u = parse(url);
      if (u && u.protocol === 'http:' && !isLocalHost(u.hostname) && !this.httpOnly.has(u.hostname) && !u.port) {
        // The same http address again right after upgrading it: the HTTPS site sends visitors back
        // to http. Stay on http for this site instead of going round in circles.
        const again = this.recent.get(url);
        if (again && Date.now() - again < 15000) { this.httpOnly.add(u.hostname); return null; }
        this.recent.set(url, Date.now());
        if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value);
        u.protocol = 'https:';
        this.upgraded.set(u.href, url);
        if (this.upgraded.size > 200) this.upgraded.delete(this.upgraded.keys().next().value);
        this.stats.upgraded++;
        return u.href;
      }
    }
    return null;
  }

  /**
   * An upgraded page failed to load over HTTPS: remember the host and return the http:// address
   * to load instead (or null if this wasn't an upgrade).
   */
  fallback(httpsUrl) {
    const orig = this.upgraded.get(httpsUrl);
    if (!orig) return null;
    this.upgraded.delete(httpsUrl);
    const u = parse(orig);
    if (u) this.httpOnly.add(u.hostname);
    return orig;
  }
}

module.exports = { Shields, debounce, stripTrackingParams, deAmpUrl, isLocalHost, TRACKING_PARAMS };
