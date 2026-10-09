'use strict';
// Local API, so other apps (the NovaDM browser extension, scripts) can hand downloads to NovaDM.
// Off by default. When on: 127.0.0.1 only, a key is required (Authorization: Bearer <key>), web pages
// are refused (any http/https Origin), and the Host header must be the local address (no DNS
// rebinding). Downloads it adds show the New download dialog unless the caller asks to start.
//
//   GET    /api/v1/ping                        -> { app, version }            (no key needed)
//   GET    /api/v1/status                      -> { active, speed, total }
//   GET    /api/v1/downloads                   -> { downloads: [...] }
//   POST   /api/v1/downloads                   <- { url | urls, name, referer, pageUrl, cookies,
//                                                  headers, dir, start }  -> { ok, ids | pending }
//   GET    /api/v1/downloads/:id               -> { download }
//   POST   /api/v1/downloads/:id/pause | resume | stop-recording
//   DELETE /api/v1/downloads/:id[?deleteFile=1]
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { specFromUrl } = require('./add-flow');

const MAX_BODY = 1024 * 1024;
const DEFAULT_PORT = 9614;

class LocalApi extends EventEmitter {
  /** ctx: { settings, downloads, addFlow, version, onAdd (bring the window forward) } */
  constructor(ctx) {
    super();
    Object.assign(this, ctx);
    this.server = null;
    this.port = 0;
  }

  key() {
    let k = this.settings.get('apiKey');
    if (!k) { k = crypto.randomBytes(16).toString('hex'); this.settings.set({ apiKey: k }); }
    return k;
  }

  newKey() {
    this.settings.set({ apiKey: crypto.randomBytes(16).toString('hex') });
    return this.key();
  }

  /** Start or stop to match the settings. Resolves with { running, port, error }. */
  async update() {
    const want = !!this.settings.get('apiEnabled');
    // 0 = any free port (tests); otherwise the chosen port, 9614 by default.
    const setting = this.settings.get('apiPort');
    const port = setting === 0 ? 0 : Number(setting) || DEFAULT_PORT;
    if (this.server && (!want || (port !== 0 && port !== this.port))) await this.stop();
    if (want && !this.server) {
      this.key();
      try { await this.listen(port); } catch (e) { return { running: false, port, error: e.code === 'EADDRINUSE' ? `Port ${port} is used by another program` : e.message }; }
    }
    return { running: !!this.server, port: this.port };
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch((e) => send(res, 500, { error: e.message })));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { this.server = server; this.port = server.address().port; resolve(); });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    return new Promise((r) => (s ? s.close(() => r()) : r()));
  }

  async handle(req, res) {
    // DNS rebinding: a web page that points its own name at 127.0.0.1 still sends that name as Host.
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(res, 403, { error: 'Wrong host' });
    // Web pages (fetch/XHR/forms from a site) are never allowed, even with a key.
    const origin = String(req.headers.origin || '');
    if (/^https?:/i.test(origin) || origin === 'null') return send(res, 403, { error: 'Not allowed from web pages' });
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // api, v1, ...
    if (parts[0] !== 'api' || parts[1] !== 'v1') return send(res, 404, { error: 'Not found' });
    const route = parts.slice(2);
    if (req.method === 'OPTIONS') return send(res, 204, null);
    if (req.method === 'GET' && route[0] === 'ping') return send(res, 200, { app: 'NovaDM', version: this.version });
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-novadm-key'] || '');
    if (!safeEqual(given, this.key())) return send(res, 401, { error: 'Missing or wrong key' });

    const d = this.downloads;
    if (req.method === 'GET' && route[0] === 'status') return send(res, 200, d.activeSummary());
    if (route[0] !== 'downloads') return send(res, 404, { error: 'Not found' });
    if (route.length === 1 && req.method === 'GET') return send(res, 200, { downloads: d.list() });
    if (route.length === 1 && req.method === 'POST') return send(res, 200, this.add(await readJson(req)));
    const rec = d.get(route[1]);
    if (!rec) return send(res, 404, { error: 'No such download' });
    if (route.length === 2 && req.method === 'GET') return send(res, 200, { download: d.list().find((x) => x.id === rec.id) });
    if (route.length === 2 && req.method === 'DELETE') { await d.cancel(rec.id, url.searchParams.get('deleteFile') === '1'); return send(res, 200, { ok: true }); }
    if (route.length === 3 && req.method === 'POST') {
      if (route[2] === 'pause') d.pause(rec.id);
      else if (route[2] === 'resume') d.resume(rec.id);
      else if (route[2] === 'stop-recording') d.stopRecording(rec.id);
      else return send(res, 404, { error: 'Not found' });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Not allowed' });
  }

  /** Add one or more links. Shown in the New download dialog unless start: true. */
  add(body) {
    const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).filter((u) => typeof u === 'string' && /^(https?:\/\/|magnet:\?)/i.test(u));
    if (!urls.length) return { ok: false, error: 'No http(s) or magnet link given' };
    const headers = {};
    for (const [k, v] of Object.entries(body.headers || {})) if (typeof v === 'string' && /^[a-z0-9-]+$/i.test(k)) headers[k.toLowerCase()] = v;
    if (typeof body.referer === 'string' && /^https?:/i.test(body.referer)) headers.referer = body.referer;
    if (typeof body.cookies === 'string' && body.cookies) headers.cookie = body.cookies;
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl : headers.referer || '';
    const specs = urls.map((u) => {
      const s = { ...specFromUrl(u, { pageUrl }), headers: { ...headers } };
      if (urls.length === 1 && typeof body.name === 'string' && body.name) s.name = body.name;
      if (typeof body.size === 'number' && urls.length === 1) s.size = body.size;
      return s;
    });
    if (this.onAdd) this.onAdd();
    if (body.start === true) {
      const ids = specs.map((s) => this.downloads.add(s).id);
      return { ok: true, ids };
    }
    if (specs.length === 1) { const r = this.addFlow.request(specs[0], { origin: 'api' }); return { ok: true, pending: !!r.pending, ids: r.id ? [r.id] : [] }; }
    this.addFlow.enqueue({ kind: 'many', specs, origin: 'api' });
    return { ok: true, pending: true };
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body == null ? '' : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Not JSON')); } });
    req.on('error', reject);
  });
}

// ---- command line and novadm:// links ---------------------------------------------------------------

/**
 * What NovaDM was started with (or what a second start passed on):
 *   NovaDM.exe --add <url> [--name <name>] [--start]   NovaDM.exe <url | magnet | file.torrent>
 *   novadm://add?url=<url>&name=<name>&referer=<page>
 * Returns [{ url | torrentFile, name, referer, start }]. novadm:// links never start by themselves.
 */
function parseLaunchArgs(argv) {
  const out = [];
  const args = argv.slice();
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--add' && args[i + 1]) {
      const item = { url: String(args[++i]), name: '', start: false };
      while (args[i + 1] && /^--(name|start)$/.test(args[i + 1])) {
        if (args[i + 1] === '--start') { item.start = true; i++; } else { item.name = String(args[i + 2] || ''); i += 2; }
      }
      if (/^(https?:\/\/|magnet:\?)/i.test(item.url)) out.push(item);
    } else if (/^novadm:\/\/add\?/i.test(a)) {
      try {
        const u = new URL(a);
        const url = u.searchParams.get('url') || '';
        if (/^(https?:\/\/|magnet:\?)/i.test(url)) out.push({ url, name: u.searchParams.get('name') || '', referer: u.searchParams.get('referer') || '', start: false });
      } catch {}
    } else if (/^magnet:\?/i.test(a) || /^https?:\/\//i.test(a)) {
      out.push({ url: a, name: '', start: false });
    } else if (/\.torrent$/i.test(a)) {
      out.push({ torrentFile: a, start: false });
    }
  }
  return out;
}

module.exports = { LocalApi, parseLaunchArgs, DEFAULT_PORT };
