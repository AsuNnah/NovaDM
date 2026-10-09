'use strict';
// Tor-style protections for normal tabs: fingerprinting protection, security levels (Tor Browser's
// Standard / Safer / Safest), and a per-site off switch in the shields panel for sites that break.
// Pages get their settings from shield-preload.js; fonts and scripts are blocked in adblock.js.
const crypto = require('crypto');
const { ipcMain } = require('electron');
const { siteOf } = require('./util');

const SESSION_KEY = crypto.randomBytes(16).toString('hex'); // fingerprint noise changes each time NovaDM starts

/** What applies to a page at `url`, or null (internal pages, or protection off for the site). */
function protectionFor(settings, url) {
  if (!/^https?:/i.test(url || '')) return null;
  const site = siteOf(url);
  if ((settings.get('hardeningOff') || []).includes(site)) return null;
  const level = ['safer', 'safest'].includes(settings.get('securityLevel')) ? settings.get('securityLevel') : 'standard';
  const fingerprinting = level === 'standard' ? (settings.get('fingerprinting') || 'standard') : 'strict';
  return {
    level,
    fingerprinting, // off | standard (noise, like Brave) | strict (read-outs blocked, like Tor)
    clickToPlay: level !== 'standard',
    blockFonts: level !== 'standard',
    noScript: level === 'safest' || (level === 'safer' && /^http:/i.test(url)),
    seed: parseInt(crypto.createHash('sha256').update(SESSION_KEY + site).digest('hex').slice(0, 8), 16),
  };
}

function install(settings) {
  // Asked synchronously by every frame before the page's own scripts run; the top page decides.
  ipcMain.on('novadm:shield-config', (e) => {
    let url = '';
    try { url = e.sender.getURL(); } catch {}
    e.returnValue = protectionFor(settings, url);
  });
}

function toggleSite(settings, url) {
  const site = siteOf(url || '');
  if (!site) return;
  const off = new Set(settings.get('hardeningOff') || []);
  if (off.has(site)) off.delete(site); else off.add(site);
  settings.set({ hardeningOff: [...off] });
}

module.exports = { protectionFor, install, toggleSite };
