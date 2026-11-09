'use strict';
// One small icon per site for the History panel (site-icons.json in the profile). Not per visit: at most
// MAX_SITES sites, the least recently seen dropped first, each icon at most MAX_BYTES. Private tabs never add to
// it, and it is cleared with history. Icons are fetched when a normal tab's page reports its icon, never because
// the panel opened.
const path = require('path');
const { JsonStore } = require('./store');

const MAX_SITES = 500;
const MAX_BYTES = 64 * 1024;
const DAY = 864e5;

const siteOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.host.toLowerCase() : ''; } catch { return ''; } };

class SiteIcons {
  constructor(dir, now = () => Date.now()) {
    this.now = now;
    this.gen = 0;
    this.store = new JsonStore(path.join(dir, 'site-icons.json'), { sites: {} });
    if (!this.store.data || typeof this.store.data.sites !== 'object' || !this.store.data.sites) this.store.data = { sites: {} };
  }

  get sites() { return this.store.data.sites; }

  /** The icon (a data: URL) for a page's site, or ''. */
  get(url) { const e = this.sites[siteOf(url)]; return e ? e.icon : ''; }

  /**
   * A normal tab's page reported its icon. `fetchIcon(iconUrl)` resolves to { type, body } (it goes through the
   * address guard). Fetches only when the site has no icon yet or its icon address changed.
   */
  async learn({ url, favicon, incognito }, fetchIcon) {
    const site = siteOf(url);
    if (incognito || !site || !/^https?:\/\//i.test(favicon || '')) return false;
    const e = this.sites[site];
    // `seen` only orders the least-recently-seen drop: a day's precision is enough, and the file stays unwritten.
    if (e && e.src === favicon) { if (this.now() - e.seen > DAY) { e.seen = this.now(); this.store.save(5000); } return false; }
    const gen = this.gen;
    let r;
    try { r = await fetchIcon(favicon); } catch { return false; }
    if (gen !== this.gen) return false; // history was cleared while the icon loaded
    if (!r || !r.body || !r.body.length || r.body.length > MAX_BYTES) return false;
    if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(r.type || '')) return false;
    this.sites[site] = { icon: `data:${r.type};base64,${r.body.toString('base64')}`, src: favicon, seen: this.now() };
    const names = Object.keys(this.sites);
    if (names.length > MAX_SITES) {
      names.sort((a, b) => this.sites[a].seen - this.sites[b].seen);
      for (const n of names.slice(0, names.length - MAX_SITES)) delete this.sites[n];
    }
    this.store.save(2000);
    return true;
  }

  /** History was cleared or visits removed: keep only the icons of sites still in it (none after "all time"). */
  keepOnly(urls) {
    this.gen++;
    const keep = new Set([...urls].map(siteOf));
    let gone = 0;
    for (const n of Object.keys(this.sites)) if (!keep.has(n)) { delete this.sites[n]; gone++; }
    if (gone) this.store.save(0);
  }

  flush() { this.store.flush(); }
}

module.exports = { SiteIcons, MAX_SITES, MAX_BYTES, siteOf };
