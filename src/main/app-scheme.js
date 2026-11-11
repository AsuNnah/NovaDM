'use strict';
// 1.8.0 (SEC-108): NovaDM's own pages are served from app://ui/<file> instead of file://, so the
// GrantFileProtocolExtraPrivileges fuse can be off. Only files inside src/ui are served.
const fs = require('fs');
const path = require('path');

const SCHEME = 'app';
const ORIGIN = 'app://ui';
const UI_DIR = path.join(__dirname, '..', 'ui');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// Before app 'ready' (Electron's rule for privileged schemes).
function registerPrivileged(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** app://ui/<page>.html with an optional query object. */
function uiUrl(file, query) {
  const u = new URL(`${ORIGIN}/${file}`);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  return u.href;
}

/** The UI file a request asks for, or '' when it is outside src/ui (or not ours). */
function fileFor(url, root = UI_DIR) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== `${SCHEME}:` || u.host !== 'ui') return '';
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return ''; }
  const file = path.resolve(root, '.' + path.sep + rel.replace(/^[\\/]+/, ''));
  return file.startsWith(root + path.sep) ? file : '';
}

async function serve(req, root = UI_DIR) {
  const file = fileFor(req.url, root);
  if (!file) return new Response('', { status: 404 });
  try {
    const body = await fs.promises.readFile(file);
    // No web page may frame NovaDM's pages (a framed page would look like NovaDM's own).
    return new Response(body, { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-security-policy': "frame-ancestors 'none'" } });
  } catch {
    return new Response('', { status: 404 });
  }
}

/** app://ui/X.html from NovaDM's top frame only. */
function isUiUrl(url) { return /^app:\/\/ui\/[\w.-]+\.html(?:[?#]|$)/i.test(url || ''); }

module.exports = { SCHEME, ORIGIN, UI_DIR, registerPrivileged, uiUrl, fileFor, serve, isUiUrl };
