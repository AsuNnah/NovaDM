'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { LocalApi, parseLaunchArgs } = require('../src/main/api');

function setup(t, extra = {}) {
  const store = { apiEnabled: true, apiPort: 0, apiKey: 'k3y', ...extra };
  const settings = { get: (k) => store[k], set: (p) => Object.assign(store, p) };
  const calls = [];
  const recs = new Map([['a1', { id: 'a1', name: 'one.zip', state: 'downloading' }]]);
  const downloads = {
    add: (s) => { calls.push(['add', s]); return { id: 'n' + calls.length }; },
    list: () => [...recs.values()], get: (id) => recs.get(id), activeSummary: () => ({ active: 1, speed: 10, total: 1 }),
    pause: (id) => calls.push(['pause', id]), resume: (id) => calls.push(['resume', id]), stopRecording: (id) => calls.push(['stop', id]),
    cancel: async (id, del) => calls.push(['cancel', id, del]),
  };
  const addFlow = { request: (s, o) => { calls.push(['ask', s, o]); return { ok: true, pending: true }; }, enqueue: (r) => calls.push(['many', r]) };
  const api = new LocalApi({ settings, downloads, addFlow, version: '9.9.9', onAdd: () => calls.push(['front']) });
  t.after(() => api.stop());
  return { api, calls, store };
}

function req(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

test('the API is off unless enabled, then answers on 127.0.0.1 with a key', async (t) => {
  const off = setup(t, { apiEnabled: false });
  assert.deepEqual(await off.api.update(), { running: false, port: undefined || 0 });
  const { api } = setup(t);
  const st = await api.update();
  assert.equal(st.running, true);
  const port = st.port;
  assert.deepEqual((await req(port, 'GET', '/api/v1/ping')).body, { app: 'NovaDM', version: '9.9.9' });
  assert.equal((await req(port, 'GET', '/api/v1/downloads')).status, 401, 'no key');
  assert.equal((await req(port, 'GET', '/api/v1/downloads', { headers: { authorization: 'Bearer nope' } })).status, 401, 'wrong key');
  const ok = await req(port, 'GET', '/api/v1/downloads', { headers: { authorization: 'Bearer k3y' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.downloads[0].name, 'one.zip');
});

test('web pages and other host names are refused, even with the key', async (t) => {
  const { api } = setup(t);
  const { port } = await api.update();
  const auth = { authorization: 'Bearer k3y' };
  assert.equal((await req(port, 'GET', '/api/v1/status', { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req(port, 'GET', '/api/v1/status', { headers: { ...auth, origin: 'null' } })).status, 403);
  assert.equal((await req(port, 'GET', '/api/v1/status', { headers: { ...auth, host: 'evil.example' } })).status, 403, 'DNS rebinding');
  const ext = await req(port, 'GET', '/api/v1/status', { headers: { ...auth, origin: 'chrome-extension://abcdefghijklmnop' } });
  assert.equal(ext.status, 200, 'the browser extension may call it');
  assert.equal(ext.body.active, 1);
});

test('adding: the dialog by default, straight away with start; cookies and Referer kept', async (t) => {
  const { api, calls } = setup(t);
  const { port } = await api.update();
  const auth = { authorization: 'Bearer k3y' };
  const r1 = await req(port, 'POST', '/api/v1/downloads', { headers: auth, body: { url: 'https://dl.example.com/a.zip', referer: 'https://example.com/page', cookies: 'sid=1', name: 'A.zip' } });
  assert.deepEqual(r1.body, { ok: true, pending: true, ids: [] });
  const ask = calls.find((c) => c[0] === 'ask');
  assert.equal(ask[1].url, 'https://dl.example.com/a.zip');
  assert.equal(ask[1].name, 'A.zip');
  assert.deepEqual(ask[1].headers, { referer: 'https://example.com/page', cookie: 'sid=1' });
  assert.equal(ask[2].origin, 'api');
  assert.ok(calls.some((c) => c[0] === 'front'), 'NovaDM comes forward');

  const r2 = await req(port, 'POST', '/api/v1/downloads', { headers: auth, body: { urls: ['https://x.example/1.mp4', 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a'], start: true } });
  assert.equal(r2.body.ids.length, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'add').map((c) => c[1].kind), ['http', 'torrent']);
  assert.equal((await req(port, 'POST', '/api/v1/downloads', { headers: auth, body: { url: 'file:///C:/x' } })).body.ok, false);
  await req(port, 'POST', '/api/v1/downloads/a1/pause', { headers: auth });
  await req(port, 'DELETE', '/api/v1/downloads/a1?deleteFile=1', { headers: auth });
  assert.ok(calls.some((c) => c[0] === 'pause' && c[1] === 'a1'));
  assert.ok(calls.some((c) => c[0] === 'cancel' && c[2] === true));
  assert.equal((await req(port, 'GET', '/api/v1/downloads/zz', { headers: auth })).status, 404);
});

test('command line and novadm:// links', () => {
  assert.deepEqual(parseLaunchArgs(['NovaDM.exe', '--add', 'https://a.example/f.iso', '--name', 'F.iso', '--start']), [{ url: 'https://a.example/f.iso', name: 'F.iso', start: true }]);
  assert.deepEqual(parseLaunchArgs(['x', 'novadm://add?url=https%3A%2F%2Fb.example%2Fv.mp4&name=V&referer=https%3A%2F%2Fb.example%2F']), [{ url: 'https://b.example/v.mp4', name: 'V', referer: 'https://b.example/', start: false }]);
  assert.deepEqual(parseLaunchArgs(['x', 'magnet:?xt=urn:btih:abc', 'D:\\files\\ubuntu.torrent', '--hidden']).map((i) => i.url || i.torrentFile), ['magnet:?xt=urn:btih:abc', 'D:\\files\\ubuntu.torrent']);
  assert.deepEqual(parseLaunchArgs(['x', 'novadm://add?url=javascript%3Aalert(1)', '--add', 'file:///C:/Windows']), [], 'only web and magnet links');
});
