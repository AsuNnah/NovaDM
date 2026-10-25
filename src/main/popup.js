'use strict';
// Pop-up guard. Decides what to do when a page asks for a new tab/window.
// Modes (like 1DM): ask (default) | block | allow. Two per-site lists override the mode: always allow, always block.
//
//   request                                         ask      block    allow    site: always block
//   known ad domain / blank window                  block    block    allow    block
//   real click, same site or Ctrl/middle click      open     open     open     open
//   real click on a link to another site            ask      ask      open     block
//   opened by a script (no real click)              ask      block    open     block
const { siteOf } = require('./util');

class PopupGuard {
  constructor(settings) { this.settings = settings; }

  siteAllowed(pageUrl) {
    const site = siteOf(pageUrl || '');
    return !!site && (this.settings.get('popupAllow') || []).includes(site);
  }

  siteBlocked(pageUrl) {
    const site = siteOf(pageUrl || '');
    return !!site && (this.settings.get('popupBlock') || []).includes(site);
  }

  /**
   * @param {object} r { pageUrl, url, click: {mods}|null, isAd: bool }
   * @returns 'open' | 'ask' | 'block'
   */
  decideRequest({ pageUrl, url, click, isAd }) {
    const mode = this.settings.get('popupMode') || 'ask';
    const web = /^https?:/i.test(url || '');
    const byHand = !!click && (!!click.mods || siteOf(url) === siteOf(pageUrl)); // Ctrl/middle click, or a link within the site
    if (this.siteAllowed(pageUrl)) return 'open';
    if (this.siteBlocked(pageUrl)) return web && !isAd && byHand ? 'open' : 'block'; // the user's own click still works
    if (mode === 'allow') return 'open';
    if (isAd || !web) return 'block';
    if (click) return byHand ? 'open' : 'ask';
    return mode === 'block' ? 'block' : 'ask';
  }

  // Kept for callers that only know the page and target.
  decide(pageUrl, popupUrl) {
    const d = this.decideRequest({ pageUrl, url: popupUrl, click: null, isAd: false });
    return d === 'open' ? 'allow' : d;
  }

  /** Always allow (true) or stop always allowing (false) this site's pop-ups; allowing takes it off the block list. */
  allowSite(pageUrl, enabled = true) { this._list(pageUrl, 'popupAllow', enabled, enabled ? 'popupBlock' : null); }

  /** Always block (true) or stop always blocking (false) this site's pop-ups; blocking takes it off the allow list. */
  blockSite(pageUrl, enabled = true) { this._list(pageUrl, 'popupBlock', enabled, enabled ? 'popupAllow' : null); }

  _list(pageUrl, key, enabled, removeFrom) {
    const site = siteOf(pageUrl || '');
    if (!site) return;
    const set = new Set(this.settings.get(key) || []);
    if (enabled) set.add(site); else set.delete(site);
    const change = { [key]: [...set] };
    if (removeFrom) change[removeFrom] = (this.settings.get(removeFrom) || []).filter((s) => s !== site);
    this.settings.set(change);
  }
}

module.exports = { PopupGuard };
