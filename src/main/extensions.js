'use strict';
// Chrome extensions: install from the Chrome Web Store and run them in the browsing session.
// electron-chrome-extensions provides chrome.tabs / action / contextMenus etc. (GPL-3.0),
// electron-chrome-web-store makes "Add to Chrome" work on chromewebstore.google.com (MIT).
// Both must be required before the app is ready (they register the crx:// scheme).
const path = require('path');
const { app, dialog, session } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

const STORE_URL = 'https://chromewebstore.google.com/';

class Extensions {
  constructor() {
    this.ext = null;
    this.ses = null;
    this.ready = false;
  }

  /**
   * @param {object} o { browser, getWindow }
   */
  async init({ browser, getWindow }) {
    this.browser = browser;
    this.ses = browser.normalSession;
    this.ext = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: this.ses,
      createTab: async (details) => {
        const id = browser.createTab({ url: details.url || 'novadm://newtab', background: details.active === false });
        return [browser.tabs.get(id).wc, getWindow()];
      },
      selectTab: (wc) => { const id = browser.tabIdForWc(wc.id); if (id != null) browser.selectTab(id); },
      removeTab: (wc) => { const id = browser.tabIdForWc(wc.id); if (id != null) browser.closeTab(id); },
      // NovaDM has one window: extension windows open as tabs.
      createWindow: async (details) => {
        const urls = [].concat(details.url || 'novadm://newtab');
        for (const u of urls) browser.createTab({ url: u });
        return getWindow();
      },
      removeWindow: () => getWindow(),
    });
    // Icons for the toolbar buttons are served over crx:// in the UI's (default) session.
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);

    await installChromeWebStore({
      session: this.ses,
      extensionsPath: path.join(app.getPath('userData'), 'Extensions'),
      autoUpdate: true,
      beforeInstall: (details) => this.confirmInstall(details, getWindow()),
    });
    this.ready = true;
  }

  // Ask before installing, listing what the extension may access.
  async confirmInstall(details, win) {
    if (!app.isPackaged && process.env.NOVADM_SELFTEST && process.env.NOVADM_TEST_AUTOINSTALL) return { action: 'allow' }; // tests only
    const m = details.manifest || {};
    const name = details.localizedName || m.name || details.id;
    const perms = [...(m.permissions || []), ...(m.host_permissions || [])].filter((p) => typeof p === 'string');
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      icon: details.icon && typeof details.icon.isEmpty === 'function' && !details.icon.isEmpty() ? details.icon : undefined,
      buttons: ['Add extension', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Add extension',
      message: `Add "${name}" to NovaDM?`,
      detail: perms.length ? `It will be able to use: ${perms.slice(0, 12).join(', ')}${perms.length > 12 ? ', …' : ''}` : 'It asks for no special permissions.',
    });
    return { action: response === 0 ? 'allow' : 'deny' };
  }

  addTab(wc, win) { if (this.ext) this.ext.addTab(wc, win); }

  selectTab(wc) { if (this.ext) this.ext.selectTab(wc); }

  contextMenuItems(wc, params) {
    try { return this.ext ? this.ext.getContextMenuItems(wc, params) : []; } catch { return []; }
  }

  list() {
    if (!this.ses) return [];
    const api = this.ses.extensions || this.ses;
    return api.getAllExtensions().map((e) => ({
      id: e.id, name: e.name, version: e.version,
      description: (e.manifest && e.manifest.description) || '',
    }));
  }

  async remove(id) {
    await uninstallExtension(id, { session: this.ses, extensionsPath: path.join(app.getPath('userData'), 'Extensions') });
  }
}

module.exports = { Extensions, STORE_URL };
