'use strict';
// Ad/tracker blocker built on the Ghostery engine, with a per-site whitelist and per-tab block
// counts. Network blocking + CSP + cosmetic (element-hiding) filters. Lists are cached to disk.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app, ipcMain } = require('electron');
const { ElectronBlocker, fromElectronDetails, adsAndTrackingLists } = require('@ghostery/adblocker-electron');
const { siteOf } = require('./util');

const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');
const INJECT_CH = '@ghostery/adblocker/inject-cosmetic-filters';
const MUTATION_CH = '@ghostery/adblocker/is-mutation-observer-enabled';

// EasyList + EasyPrivacy + uBlock Origin lists (Ghostery preset), plus OISD Big: a domain list that
// covers pop-under / redirect ad networks (1DM ships OISD among its hosts sources too).
const EXTRA_LISTS = ['https://big.oisd.nl/'];
// Deceptive sites: checked on page loads themselves (the ad lists skip those), whatever the Shields
// setting. Phishing URL Blocklist (OpenPhish, PhishTank; updated twice a day) and uBlock's Badware risks.
const PHISHING_LISTS = ['https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt', 'https://ublockorigin.github.io/uAssets/filters/badware.txt'];
const PHISHING_REFRESH_MS = 24 * 3600 * 1000;
const LIST_VERSION = 2; // bump when the list set changes, so old caches are rebuilt
const REFRESH_MS = 4 * 24 * 3600 * 1000;

class AdBlocker extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.engine = null;
    this.ready = false;
    this.counts = new Map(); // webContentsId -> blocked count
    const dir = app.getPath('userData');
    this.cachePath = path.join(dir, `adblock-engine-v${LIST_VERSION}.bin`);
    try { fs.rmSync(path.join(dir, 'adblock-engine.bin'), { force: true }); } catch {} // pre-v2 cache
    this._preloadId = null;
    this.phish = null; // engine for PHISHING_LISTS
    this.phishPath = path.join(dir, 'phishing-v1.bin');
    this.phishBlocked = new Set(); // page loads just stopped (browser.js shows the warning)
    this.phishAllowed = new Set(); // sites the user chose to open anyway, until NovaDM closes
  }

  /** Load the phishing lists (cached for a day). Failure leaves the check off until the next try. */
  async initPhishing() {
    try {
      const st = await fs.promises.stat(this.phishPath);
      this.phish = ElectronBlocker.deserialize(await fs.promises.readFile(this.phishPath));
      if (Date.now() - st.mtimeMs < PHISHING_REFRESH_MS) return;
    } catch {}
    try {
      const engine = await ElectronBlocker.fromLists(fetch, PHISHING_LISTS, { loadCosmeticFilters: false });
      await fs.promises.writeFile(this.phishPath, engine.serialize());
      this.phish = engine;
    } catch (err) {
      console.error('phishing lists: could not load', err.message);
    }
  }

  /** A page load (main frame) to a listed site the user hasn't allowed. */
  isPhishing(details) {
    if (!this.phish || this.settings.get('phishingCheck') === false || this.phishAllowed.has(siteOf(details.url))) return false;
    return !!this.phish.match(fromElectronDetails(details)).match;
  }

  allowPhishing(url) { this.phishAllowed.add(siteOf(url)); }

  // Download all lists and build a fresh engine. Falls back to the preset if an extra list fails.
  async build() {
    let engine;
    try {
      engine = await ElectronBlocker.fromLists(fetch, [...adsAndTrackingLists, ...EXTRA_LISTS]);
    } catch (err) {
      console.error('adblock: extra lists failed, using preset only', err.message);
      engine = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists);
    }
    await fs.promises.writeFile(this.cachePath, engine.serialize());
    return engine;
  }

  async init() {
    let cachedAt = 0;
    try {
      const st = await fs.promises.stat(this.cachePath);
      this.engine = ElectronBlocker.deserialize(await fs.promises.readFile(this.cachePath));
      cachedAt = st.mtimeMs;
    } catch {
      this.engine = null;
    }
    if (!this.engine) {
      try {
        this.engine = await this.build();
        cachedAt = Date.now();
      } catch (err) {
        // Offline first run: start with an empty engine so the browser still works.
        console.error('adblock: list fetch failed, starting empty', err.message);
        this.engine = await ElectronBlocker.fromLists(fetch, []).catch(() => ElectronBlocker.parse(''));
      }
    }
    this.ready = true;
    this.settings.data.adblockUpdatedAt = cachedAt;
    this.settings.store.save();
    // Lists older than a few days: rebuild in the background and swap the engine in.
    if (cachedAt && Date.now() - cachedAt > REFRESH_MS) this.refresh();
  }

  async refresh() {
    try {
      this.engine = await this.build();
      this.settings.data.adblockUpdatedAt = Date.now();
      this.settings.store.save();
      this.emit('updated');
    } catch (err) {
      console.error('adblock: refresh failed', err.message);
    }
  }

  siteWhitelisted(url) {
    if (!this.settings.get('adblock')) return true;
    const site = siteOf(url || '');
    if (!site) return false;
    return (this.settings.get('adblockWhitelist') || []).includes(site);
  }

  pageUrlFor(details) {
    const wc = details.webContents;
    if (wc && !wc.isDestroyed()) {
      try { const u = wc.getURL(); if (u) return u; } catch {}
    }
    return details.referrer || '';
  }

  registerIpcOnce() {
    if (this._ipcDone) return;
    this._ipcDone = true;
    // Cosmetic filters: preload reports DOM info; we inject CSS/scriptlets unless whitelisted.
    ipcMain.handle(INJECT_CH, (event, url, msg) => {
      if (!this.engine || this.cosmetic === false || this.siteWhitelisted(url)) return; // cosmetic=false: benchmark only
      return this.engine.onInjectCosmeticFilters(event, url, msg);
    });
    ipcMain.handle(MUTATION_CH, (event) => (this.engine ? this.engine.onIsMutationObserverEnabled(event) : false));
  }

  /**
   * Install the request hooks on a session (once). They run from the first request; ad blocking
   * starts when the lists are loaded. `this.shields` (main) rewrites page addresses (Shields).
   */
  attach(session) {
    if (!this._attached) this._attached = new WeakSet();
    if (this._attached.has(session)) return;
    this._attached.add(session);
    this.registerIpcOnce();
    session.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH });

    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const isMain = details.resourceType === 'mainFrame';
      if (isMain && this.isPhishing(details)) { this.phishBlocked.add(details.url); return callback({ cancel: true }); }
      if (this.shields && (isMain || details.resourceType === 'subFrame') && details.method === 'GET' && details.webContents) {
        const to = this.shields.rewrite(details.url, { isMain });
        if (to && to !== details.url) return callback({ redirectURL: to });
      }
      // Security level Safer / Safest (hardening.js): no web fonts.
      if (details.resourceType === 'font' && this.protection) {
        const p = this.protection(this.pageUrlFor(details));
        if (p && p.blockFonts) return callback({ cancel: true });
      }
      if (!this.ready || !this.engine) return callback({});
      const pageUrl = this.pageUrlFor(details);
      if (this.siteWhitelisted(pageUrl)) return callback({});
      const request = fromElectronDetails(details);
      if (request.type === 'other') request.guessTypeOfRequest();
      if (request.isMainFrame()) return callback({});
      const { redirect, match } = this.engine.match(request);
      if (redirect) return callback({ redirectURL: redirect.dataUrl });
      if (match) { this.bump(details.webContents); return callback({ cancel: true }); }
      callback({});
    });

    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      // Security level Safest (and Safer on http:// pages): no scripts, through the page's CSP.
      let headers = null;
      if (this.protection && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
        const p = this.protection(details.resourceType === 'mainFrame' ? details.url : this.pageUrlFor(details));
        if (p && p.noScript) {
          // An extra policy on top of the site's own: browsers enforce every CSP header given.
          headers = { ...details.responseHeaders };
          const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
          headers[key] = [...[].concat(headers[key] || []), "script-src 'none'"];
          details.responseHeaders = headers;
        }
      }
      const done = (r = {}) => callback(r.responseHeaders || !headers ? r : { responseHeaders: headers });
      if (!this.ready || !this.engine || this.siteWhitelisted(this.pageUrlFor(details))) return done();
      this.engine.onHeadersReceived(details, done);
    });
  }

  /** True when `url` belongs to a known ad/tracker domain (used to block ad pop-ups outright). */
  isAdUrl(url, pageUrl) {
    if (!this.ready || this.siteWhitelisted(pageUrl)) return false;
    try {
      const { Request } = require('@ghostery/adblocker-electron');
      for (const type of ['sub_frame', 'script']) {
        const req = Request.fromRawDetails({ url, sourceUrl: pageUrl || url, type });
        if (this.engine.match(req).match) return true;
      }
    } catch {}
    return false;
  }

  bump(wc) {
    if (!wc || wc.isDestroyed()) return;
    const n = (this.counts.get(wc.id) || 0) + 1;
    this.counts.set(wc.id, n);
    this.emit('blocked', wc.id, n);
  }

  resetTab(wcId) {
    if (this.counts.get(wcId)) { this.counts.set(wcId, 0); this.emit('blocked', wcId, 0); }
  }

  removeTab(wcId) { this.counts.delete(wcId); }

  count(wcId) { return this.counts.get(wcId) || 0; }

  isWhitelisted(url) {
    const site = siteOf(url || '');
    return site ? (this.settings.get('adblockWhitelist') || []).includes(site) : false;
  }

  setSiteEnabled(url, enabled) {
    const site = siteOf(url || '');
    if (!site) return;
    const list = new Set(this.settings.get('adblockWhitelist') || []);
    if (enabled) list.delete(site); else list.add(site);
    this.settings.set({ adblockWhitelist: [...list] });
    this.emit('whitelistChanged');
  }
}

module.exports = { AdBlocker };
