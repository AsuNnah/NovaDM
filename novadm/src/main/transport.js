'use strict';
// Download transports.
//   browser - Electron `net` (Chromium network stack): the page's own cookies, TLS, proxy, Secure DNS.
//             Chromium allows only 6 connections per server on HTTP/1.1.
//   direct  - undici (Node's HTTP client) with no per-server cap. To behave like the browser it takes:
//             cookies copied from the browsing session, the page's replayed headers, Secure DNS through
//             session.resolveHost(), the session's proxy (HTTP proxies), and Windows' certificate store.
// Both return the same connection shape as net.open(): { res, status, headers, finalUrl, abort }.
const tls = require('tls');
const { Readable } = require('stream');
const net = require('./net');

let undici = null;
function getUndici() { if (!undici) undici = require('undici'); return undici; }

let caBundle = null;
function caCertificates() {
  if (caBundle) return caBundle;
  try {
    // Node's bundled roots plus Windows' store (antivirus HTTPS scanning and company CAs live there).
    caBundle = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
  } catch {
    caBundle = undefined;
  }
  return caBundle;
}

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

class Transport {
  constructor({ session, settings }) {
    this.session = session;
    this.settings = settings;
    this.agents = new Map(); // proxy key -> undici dispatcher
    this.directBlocked = new Map(); // host -> reason (direct refused; use the browser stack)
  }

  // ---- policy ----------------------------------------------------------------------------------

  mode() { return this.settings ? this.settings.get('downloadTransport') || 'auto' : 'auto'; }

  /** Should an extra connection to this URL go direct? */
  useDirect(url) {
    const m = this.mode();
    if (m === 'browser') return false;
    let host = '';
    try { host = new URL(url).hostname; } catch { return false; }
    if (this.directBlocked.has(host)) return false;
    return m === 'direct' || m === 'auto';
  }

  blockDirect(url, reason) {
    try { this.directBlocked.set(new URL(url).hostname, reason); } catch {}
  }

  /**
   * Open a request. opts: { headers, range, timeoutMs, direct (bool), session }
   * Direct requests that fail with a refusal (TLS, 403 before data, connection reset) block direct
   * mode for that host so later connections use the browser stack.
   */
  async open(url, opts = {}) {
    const ses = opts.session || this.session;
    if (!opts.direct) return net.open(url, { ...opts, session: ses });
    try {
      const conn = await this.directOpen(url, { ...opts, session: ses });
      if (conn.status === 403 && opts.firstConnection) this.blockDirect(url, '403');
      return conn;
    } catch (err) {
      if (isRefusal(err)) {
        this.blockDirect(url, err.code || err.message);
        return net.open(url, { ...opts, session: ses });
      }
      throw err;
    }
  }

  // ---- direct (undici) -------------------------------------------------------------------------

  async dispatcherFor(url, ses) {
    const { Agent, ProxyAgent } = getUndici();
    let proxy = 'DIRECT';
    try { proxy = await ses.resolveProxy(url); } catch {}
    // "PROXY host:port; DIRECT" -> first entry. SOCKS isn't supported by undici: use the browser stack.
    const first = String(proxy || 'DIRECT').split(';')[0].trim();
    if (/^SOCKS/i.test(first)) { const e = new Error('SOCKS proxy: browser stack only'); e.code = 'NOVADM_SOCKS'; throw e; }
    const key = first || 'DIRECT';
    let d = this.agents.get(key);
    if (d) return d;
    const connect = {
      ca: caCertificates(),
      timeout: 15000,
      // Secure DNS: resolve through the browser session (DNS-over-HTTPS when enabled).
      lookup: (hostname, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {}; }
        ses.resolveHost(hostname, { queryType: options && options.family === 6 ? 'AAAA' : undefined })
          .then((r) => {
            const list = (r.endpoints || []).map((e) => ({ address: e.address, family: e.family === 'ipv6' ? 6 : 4 }));
            if (!list.length) return cb(Object.assign(new Error('DNS lookup failed for ' + hostname), { code: 'ENOTFOUND' }));
            if (options && options.all) return cb(null, list);
            const v4 = list.find((x) => x.family === 4) || list[0];
            cb(null, v4.address, v4.family);
          })
          .catch((e) => cb(Object.assign(e, { code: e.code || 'ENOTFOUND' })));
      },
    };
    const m = /^PROXY\s+(.+)$/i.exec(first) || /^HTTPS\s+(.+)$/i.exec(first);
    if (m) {
      const scheme = /^HTTPS/i.test(first) ? 'https' : 'http';
      d = new ProxyAgent({ uri: `${scheme}://${m[1]}`, connections: 64, requestTls: { ca: caCertificates() } });
    } else {
      // Many sockets per origin: the whole point of direct mode. HTTP/1.1 so each range is its own TCP stream.
      d = new Agent({ connections: 64, pipelining: 0, connect, allowH2: false, keepAliveTimeout: 20000 });
    }
    this.agents.set(key, d);
    return d;
  }

  async cookieHeader(url, ses) {
    try {
      const list = await ses.cookies.get({ url });
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  }

  async directOpen(url, { headers = {}, range, timeoutMs = 30000, session: ses }) {
    const { request } = getUndici();
    const dispatcher = await this.dispatcherFor(url, ses);
    let current = url;
    for (let hop = 0; hop < 15; hop++) {
      const h = {};
      for (const [k, v] of Object.entries(headers)) {
        const key = k.toLowerCase();
        if (v == null || v === '' || HOP_HEADERS.has(key) || key === 'x-novadm-referer') continue;
        h[key] = String(v);
      }
      h['user-agent'] = ses.getUserAgent();
      if (range) h.range = range;
      if (!h['accept-encoding']) h['accept-encoding'] = 'identity'; // ranges must be byte-exact
      const cookie = await this.cookieHeader(current, ses);
      if (cookie) h.cookie = cookie;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      let resp;
      try {
        resp = await request(current, { method: 'GET', headers: h, dispatcher, signal: ac.signal, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
      } finally {
        clearTimeout(timer);
      }
      const status = resp.statusCode;
      if (status >= 300 && status < 400 && resp.headers.location) {
        resp.body.destroy();
        current = new URL(resp.headers.location, current).href;
        continue;
      }
      const flat = {};
      for (const [k, v] of Object.entries(resp.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      const body = resp.body;
      // Shape the body like Electron's IncomingMessage: data/end/error/aborted + pause/resume.
      body.on('error', (e) => { if (e && (e.name === 'AbortError' || e.code === 'UND_ERR_ABORTED')) body.emit('aborted'); });
      return {
        res: body, status, headers: flat, finalUrl: current, transport: 'direct', httpVersion: '1.1',
        abort() { try { body.destroy(); } catch {} },
      };
    }
    throw new Error('Too many redirects');
  }

  async close() {
    for (const d of this.agents.values()) { try { await d.close(); } catch {} }
    this.agents.clear();
  }
}

function isRefusal(err) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  return /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|EPROTO|ECONNRESET|NOVADM_SOCKS|UND_ERR_SOCKET|HPE_/i.test(code)
    || /certificate|handshake|SOCKS/i.test(String(err && err.message));
}

module.exports = { Transport, isRefusal, Readable };
