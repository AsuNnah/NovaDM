'use strict';
// Proxy for browsing and downloads: system settings (default), none, a manual HTTP/HTTPS/SOCKS
// server, or a PAC script. Applied to every session NovaDM uses; the direct download transport picks
// it up through session.resolveProxy(). The password is kept encrypted with Windows' DPAPI
// (Electron safeStorage), never in plain text.
const { safeStorage } = require('electron');

const TYPES = ['http', 'https', 'socks4', 'socks5'];

function proxyConfig(s) {
  const mode = s.get('proxyMode');
  if (mode === 'none') return { mode: 'direct' };
  if (mode === 'manual') {
    const server = String(s.get('proxyServer') || '').trim().replace(/^[a-z0-9]+:\/\//i, '');
    if (!server) return { mode: 'system' };
    const type = TYPES.includes(s.get('proxyType')) ? s.get('proxyType') : 'http';
    return { mode: 'fixed_servers', proxyRules: `${type}://${server}`, proxyBypassRules: s.get('proxyBypass') || '<local>' };
  }
  if (mode === 'pac') {
    const pac = String(s.get('proxyPac') || '').trim();
    return pac ? { mode: 'pac_script', pacScript: pac } : { mode: 'system' };
  }
  return { mode: 'system' };
}

async function applyProxy(settings, sessions) {
  const cfg = proxyConfig(settings);
  for (const ses of sessions) {
    try {
      await ses.setProxy(cfg);
      await ses.closeAllConnections(); // existing keep-alive connections would bypass the change
    } catch (e) {
      console.error('proxy: could not apply', e.message);
    }
  }
  return cfg;
}

async function encryptPassword(pw) {
  if (!pw) return '';
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows could not protect the password');
  return (await safeStorage.encryptStringAsync(String(pw))).toString('base64');
}

// Decrypted passwords by their encrypted form. Decrypting is asynchronous since Electron 45 (the synchronous
// calls go in 46), but the places that need a password (a proxy or site sign-in, the direct transport) are
// synchronous, so they read this cache; primeCredentials fills it at start and whenever those settings change.
const plain = new Map();
async function primeCredentials(settings) {
  const encs = [settings.get('proxyPassEnc'), ...(settings.get('siteSettings') || []).map((s) => s && s.passEnc)].filter((e) => e && !plain.has(e));
  await Promise.all(encs.map(async (enc) => {
    try { plain.set(enc, (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result); } catch {} // left out: tried again on the next change
  }));
}
function decryptedPassword(enc) { return (enc && plain.get(enc)) || ''; }

/** { user, pass } for the configured proxy, or null. */
function proxyCredentials(settings) {
  const user = settings.get('proxyUser');
  if (!user || settings.get('proxyMode') === 'none') return null;
  return { user, pass: decryptedPassword(settings.get('proxyPassEnc')) };
}

module.exports = { proxyConfig, applyProxy, encryptPassword, primeCredentials, decryptedPassword, proxyCredentials, TYPES };
