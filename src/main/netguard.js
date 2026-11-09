'use strict';
// Is a web address on this PC or on a private network? Used so that a page on the internet cannot make NovaDM
// fetch (blind GET) things on 127.0.0.1, the home router, a NAS and the like through its automatic media checks.
// 1.8.0 (SEC-104): a guarded fetch looks the name up once, through the session (Secure DNS), and connects to the
// address it checked (undici, see openerFor), so a name that answers differently the second time (DNS rebinding)
// can't slip through. Behind a proxy the proxy looks names up: then only the name and literal addresses are checked.
const dns = require('dns').promises;
const net = require('net');

/** IPv4 as four numbers, or null. */
function v4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

/** Loopback, private, link-local, CGNAT, "this network", benchmarking, multicast and reserved addresses. */
function isPrivateIp(ip) {
  ip = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const four = v4(ip);
  if (four) {
    const [a, b, c] = four;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT (Tailscale and the like)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (!net.isIPv6(ip)) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) || /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip); // ::ffff:7f00:1 written in hex
  if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`); }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
}

const cache = new Map(); // host -> { at, priv }
const CACHE_MS = 30 * 1000;

/** True when the address is private or local. A name that can't be looked up is "no": the request fails by itself. */
async function isPrivateUrl(url, { lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  if (!host) return false;
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || v4(host)) return isPrivateIp(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || !host.includes('.')) return true;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.priv;
  let priv = false;
  try {
    const list = await Promise.race([lookup(host), new Promise((_, rej) => setTimeout(() => rej(new Error('lookup timed out')), 4000))]);
    priv = list.some((a) => isPrivateIp(a.address));
  } catch { priv = false; }
  cache.set(host, { at: Date.now(), priv });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return priv;
}

/**
 * Is the page itself local? Only a literal private address or a reserved name counts, never a DNS answer: a site
 * could answer its own name with a private address too and so switch the guard off for itself (SEC-104).
 */
function isLocalPage(pageUrl) {
  let host;
  try { host = new URL(pageUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  if (!host) return false;
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || v4(host)) return isPrivateIp(host);
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || !host.includes('.');
}

/**
 * A request guard for automatic fetches made because of what a page showed: refuses private and local addresses
 * unless the page itself is on one (a media server at home, a test page on localhost).
 */
function guardFor(pageUrl, opts) {
  return async (url) => {
    if (isLocalPage(pageUrl)) return; // the page is local: it could ask for these itself
    if (await isPrivateUrl(url, opts)) throw new Error('Not fetched: a page on the internet asked for an address on this PC or a private network');
  };
}

/** The session's resolver as a lookup for isPrivateUrl (Secure DNS when it is on, never the OS behind its back). */
const sessionLookup = (ses) => async (host) => ((await ses.resolveHost(host)).endpoints || []).map((e) => ({ address: e.address }));

const pinned = new WeakMap(); // session -> Transport that refuses private addresses at connect time
/**
 * How a guarded fetch for pageUrl connects (net.fetchBuffer's `opener`): through a pinned direct connection that
 * refuses private addresses, unless the page itself is local or a proxy does the lookups (then Chromium's stack).
 */
function openerFor(ses, pageUrl, { Transport = require('./transport').Transport, open = require('./net').open } = {}) {
  return async (url, opts) => {
    if (isLocalPage(pageUrl)) return open(url, opts);
    let proxy = 'DIRECT';
    try { proxy = await ses.resolveProxy(url); } catch {}
    if (!/^DIRECT/i.test(String(proxy || 'DIRECT').split(';')[0].trim())) return open(url, opts);
    let t = pinned.get(ses);
    if (!t) { t = new Transport({ session: ses, refuse: isPrivateIp }); pinned.set(ses, t); }
    return t.directOpen(url, { headers: opts.headers, timeoutMs: opts.timeoutMs, session: ses });
  };
}

module.exports = { isPrivateIp, isPrivateUrl, isLocalPage, guardFor, sessionLookup, openerFor };
