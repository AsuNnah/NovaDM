'use strict';
// Pop-up guard. Decides what to do when a page asks for a new tab/window.
// Modes (like 1DM): ask (default) | block | allow. A per-site allow list overrides to allow.
//
//   request                                         ask      block    allow
//   known ad domain / blank window                  block    block    allow
//   real click, same site or Ctrl/middle click      open     open     open
//   real click on a link to another site            ask      ask      open
//   opened by a script (no real click)              ask      block    open
const { siteOf } = require('./util');

class PopupGuard {
  constructor(settings) { this.settings = settings; }

  siteAllowed(pageUrl) {
    const site = siteOf(pageUrl || '');
    return !!site && (this.settings.get('popupAllow') || []).includes(site);
  }

  /**
   * @param {object} r { pageUrl, url, click: {mods}|null, isAd: bool }
   * @returns 'open' | 'ask' | 'block'
   */
  decideRequest({ pageUrl, url, click, isAd }) {
    const mode = this.settings.get('popupMode') || 'ask';
    if (mode === 'allow' || this.siteAllowed(pageUrl)) return 'open';
    if (isAd || !/^https?:/i.test(url || '')) return 'block';
    if (click) {
      if (click.mods || siteOf(url) === siteOf(pageUrl)) return 'open';
      return 'ask';
    }
    return mode === 'block' ? 'block' : 'ask';
  }

  // Kept for callers that only know the page and target.
  decide(pageUrl, popupUrl) {
    const d = this.decideRequest({ pageUrl, url: popupUrl, click: null, isAd: false });
    return d === 'open' ? 'allow' : d;
  }

  allowSite(pageUrl, enabled = true) {
    const site = siteOf(pageUrl || '');
    if (!site) return;
    const set = new Set(this.settings.get('popupAllow') || []);
    if (enabled) set.add(site); else set.delete(site);
    this.settings.set({ popupAllow: [...set] });
  }
}

module.exports = { PopupGuard };
