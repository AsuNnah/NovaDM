'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Transport } = require('../src/main/transport');

// Stand-in for an Electron session: Secure DNS lookups, proxy, user agent and cookies.
function fakeSession({ proxy = 'DIRECT' } = {}) {
  const lookups = [];
  return {
    lookups,
    resolveHost: async (host) => { lookups.push(host); return { endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] }; },
    resolveProxy: async () => proxy,
    getUserAgent: () => 'NovaDM-Test/1.0',
    cookies: { get: async ({ url }) => (new URL(url).pathname.startsWith('/f') ? [{ name: 'sid', value: 'abc' }, { name: 'lang', value: 'en' }] : []) },
  };
}
const settings = (mode = 'auto') => ({ get: (k) => (k === 'downloadTransport' ? mode : undefined) });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const read = (conn) => new Promise((res, rej) => { const c = []; conn.res.on('data', (d) => c.push(d)); conn.res.on('end', () => res(Buffer.concat(c))); conn.res.on('error', rej); });

test('direct requests carry cookies, Referer, user agent and range, and resolve DNS through the session', async (t) => {
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(206, { 'Content-Range': 'bytes 0-9/100', 'Content-Length': 10 });
    res.end(Buffer.alloc(10, 7));
  });
  t.after(() => server.close());
  const port = await listen(server);
  const ses = fakeSession();
  const tr = new Transport({ session: ses, settings: settings() });
  t.after(() => tr.close());
  const conn = await tr.open(`http://nova.test:${port}/file.bin`, { direct: true, range: 'bytes=0-9', headers: { referer: 'https://page.example/watch', 'x-novadm-referer': 'ignored' } });
  assert.equal(conn.status, 206);
  assert.equal(conn.transport, 'direct');
  assert.equal((await read(conn)).length, 10);
  assert.deepEqual(ses.lookups, ['nova.test'], 'host resolved by the session (Secure DNS)');
  assert.equal(seen.cookie, 'sid=abc; lang=en');
  assert.equal(seen.referer, 'https://page.example/watch');
  assert.equal(seen['user-agent'], 'NovaDM-Test/1.0');
  assert.equal(seen.range, 'bytes=0-9');
  assert.equal(seen['accept-encoding'], 'identity');
  assert.ok(!('x-novadm-referer' in seen), 'internal header is not sent');
});

test('redirects are followed and the final URL is reported', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { Location: '/new' }); return res.end(); }
    res.writeHead(200, { 'Content-Length': 2 }); res.end('ok');
  });
  t.after(() => server.close());
  const port = await listen(server);
  const tr = new Transport({ session: fakeSession(), settings: settings() });
  t.after(() => tr.close());
  const conn = await tr.open(`http://127.0.0.1:${port}/old`, { direct: true });
  assert.equal(conn.status, 200);
  assert.equal(conn.finalUrl, `http://127.0.0.1:${port}/new`);
  await read(conn);
});

test('a server that refuses the direct client is retried through the browser stack and remembered', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(403); res.end('bot check'); });
  t.after(() => server.close());
  const port = await listen(server);
  const browserCalls = [];
  const browserOpen = async (url) => { browserCalls.push(url); return { status: 206, headers: {}, transport: 'browser', abort() {} }; };
  const tr = new Transport({ session: fakeSession(), settings: settings(), browserOpen });
  t.after(() => tr.close());
  const url = `http://127.0.0.1:${port}/f.bin`;
  assert.equal(tr.useDirect(url), true);
  const conn = await tr.open(url, { direct: true, range: 'bytes=10-' });
  assert.equal(conn.transport, 'browser');
  assert.deepEqual(browserCalls, [url]);
  assert.equal(tr.useDirect(url), false, 'later connections to this server use the browser stack');
});

test('"browser only" mode never goes direct; SOCKS proxies fall back to the browser stack', async () => {
  const tr = new Transport({ session: fakeSession(), settings: settings('browser') });
  assert.equal(tr.useDirect('https://cdn.example.com/a.mp4'), false);
  const calls = [];
  const tr2 = new Transport({ session: fakeSession({ proxy: 'SOCKS5 127.0.0.1:1080' }), settings: settings(), browserOpen: async (u) => { calls.push(u); return { status: 200, transport: 'browser', abort() {} }; } });
  const conn = await tr2.open('http://cdn.example.com/a.mp4', { direct: true });
  assert.equal(conn.transport, 'browser');
  assert.equal(tr2.useDirect('http://cdn.example.com/b.mp4'), false);
});

test('direct transport opens more than 6 connections to one server at once', async (t) => {
  const stats = { active: 0, peak: 0 };
  const server = http.createServer((req, res) => {
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    setTimeout(() => { res.writeHead(200, { 'Content-Length': 1 }); res.end('x', () => { stats.active--; }); }, 300);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const tr = new Transport({ session: fakeSession(), settings: settings() });
  t.after(() => tr.close());
  const conns = await Promise.all(Array.from({ length: 16 }, (_, i) => tr.open(`http://127.0.0.1:${port}/p${i}`, { direct: true })));
  await Promise.all(conns.map(read));
  assert.ok(stats.peak >= 12, 'parallel connections: ' + stats.peak);
});
