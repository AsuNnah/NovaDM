'use strict';
// HTTP helpers on Chromium's network stack (Electron `net`), so requests share the browser's
// cookies, proxy settings, HTTP/2 and TLS behaviour.
const { net } = require('electron');

// Request headers worth replaying from the page's own request.
const SKIP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'range', 'if-range', 'if-none-match',
  'if-modified-since', 'cookie', 'user-agent', 'upgrade-insecure-requests', 'te', 'trailer',
  'transfer-encoding', 'keep-alive', 'proxy-connection', 'priority',
]);

function replayableHeaders(requestHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(requestHeaders || {})) {
    const key = k.toLowerCase();
    if (SKIP_HEADERS.has(key) || key.startsWith('sec-') || key.startsWith(':')) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

const REFERER_TAG = 'x-swoop-referer';

/** Must be installed on every session Swoop downloads with (see open()). */
function installRefererHook(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    const key = Object.keys(h).find((k) => k.toLowerCase() === REFERER_TAG);
    if (!key) return callback({});
    const ref = h[key];
    delete h[key];
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'referer') delete h[k];
    h.Referer = ref;
    callback({ requestHeaders: h });
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    // 408/425/429/5xx are worth retrying; other 4xx are not.
    this.fatal = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
  }
}

function normHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

/**
 * Open a GET request and resolve when the response headers arrive.
 * Redirects are followed manually so the final URL is known.
 * Returns { res, req, status, headers, finalUrl, abort() }.
 */
function open(url, { session, headers = {}, range, timeoutMs = 30000, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    let finalUrl = url;
    let redirects = 0;
    let settled = false;
    const req = net.request({ url, method, session, useSessionCookies: true, redirect: 'manual', cache: 'no-store' });
    const ua = session ? session.getUserAgent() : null;
    const all = { ...headers };
    if (ua) all['user-agent'] = ua;
    if (range) all.range = range;
    // Chromium rejects a Referer set directly on net requests (ERR_BLOCKED_BY_CLIENT); the
    // session's onBeforeSendHeaders hook (see installRefererHook) turns this into a real Referer.
    if (all.referer) { all[REFERER_TAG] = all.referer; delete all.referer; }
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || v === null || v === '') continue;
      try { req.setHeader(k, v); } catch { /* header not allowed by Chromium */ }
    }
    const timer = setTimeout(() => fail(new Error('Connection timed out')), timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.abort(); } catch {}
      reject(err);
    }
    req.on('redirect', (status, m, redirectUrl) => {
      if (++redirects > 15) return fail(new Error('Too many redirects'));
      finalUrl = redirectUrl;
      req.followRedirect();
    });
    req.on('response', (res) => {
      if (settled) { try { req.abort(); } catch {} return; }
      settled = true;
      clearTimeout(timer);
      resolve({
        req, res, finalUrl, status: res.statusCode, headers: normHeaders(res.headers),
        abort() { try { req.abort(); } catch {} },
      });
    });
    req.on('error', (err) => fail(err));
    req.on('abort', () => fail(new Error('Aborted')));
    req.end();
  });
}

/** Read a whole response body (with an optional size cap). */
function readBody(conn, maxBytes = 64 * 1024 * 1024, idleMs = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let idle = setTimeout(onIdle, idleMs);
    function onIdle() { conn.abort(); reject(new Error('Connection stalled')); }
    conn.res.on('data', (c) => {
      clearTimeout(idle); idle = setTimeout(onIdle, idleMs);
      len += c.length;
      if (len > maxBytes) { clearTimeout(idle); conn.abort(); reject(new Error('Response too large')); return; }
      chunks.push(c);
    });
    conn.res.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
    conn.res.on('error', (e) => { clearTimeout(idle); reject(e); });
    conn.res.on('aborted', () => { clearTimeout(idle); reject(new Error('Connection closed')); });
  });
}

async function fetchBuffer(url, opts = {}) {
  const conn = await open(url, opts);
  if (conn.status >= 400) { conn.abort(); throw new HttpError(conn.status); }
  const body = await readBody(conn, opts.maxBytes, opts.timeoutMs);
  return { status: conn.status, headers: conn.headers, finalUrl: conn.finalUrl, body };
}

async function fetchText(url, opts = {}) {
  const r = await fetchBuffer(url, { maxBytes: 16 * 1024 * 1024, ...opts });
  return { ...r, text: r.body.toString('utf8') };
}

/** Headers-only probe using a 1-byte range request; returns size, name hints and type. */
async function probe(url, opts = {}) {
  const conn = await open(url, { ...opts, range: 'bytes=0-0' });
  conn.abort();
  if (conn.status >= 400) throw new HttpError(conn.status);
  const h = conn.headers;
  let size = -1;
  let resumable = false;
  const cr = /bytes\s+\d+-\d+\/(\d+)/i.exec(h['content-range'] || '');
  if (conn.status === 206 && cr) { size = Number(cr[1]); resumable = true; }
  else if (h['content-length']) size = Number(h['content-length']);
  return {
    status: conn.status, finalUrl: conn.finalUrl, size, resumable,
    mime: (h['content-type'] || '').split(';')[0].trim().toLowerCase(),
    disposition: h['content-disposition'] || '', headers: h,
  };
}

module.exports = { open, readBody, fetchBuffer, fetchText, probe, replayableHeaders, installRefererHook, HttpError };
