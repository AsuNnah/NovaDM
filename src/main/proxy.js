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

function encryptPassword(pw) {
  if (!pw) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not protect the password');
  return safeStorage.encryptString(String(pw)).toString('base64');
}

/** { user, pass } for the configured proxy, or null. */
function proxyCredentials(settings) {
  const user = settings.get('proxyUser');
  if (!user || settings.get('proxyMode') === 'none') return null;
  let pass = '';
  try {
    const enc = settings.get('proxyPassEnc');
    if (enc) pass = safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {}
  return { user, pass };
}

module.exports = { proxyConfig, applyProxy, encryptPassword, proxyCredentials, TYPES };
