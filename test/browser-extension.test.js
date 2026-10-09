'use strict';
// The browser extension's code, run in Node with a stand-in for the chrome.* API, talking to NovaDM's
// real local API (with a stand-in download list).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const lib = require('../browser-extension/lib');
const { LocalApi } = require('../src/main/api');

const MB = 1024 * 1024;

test('which browser downloads go to NovaDM', () => {
  const s = { key: 'k', intercept: true, minSizeMB: 1 };
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/big.zip', fileSize: 50 * MB }, s, 'me'), true);
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/x.bin', mime: 'video/mp4', fileSize: 0 }, s, 'me'), true, 'videos, size unknown');
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/small.zip', fileSize: 100 * 1024 }, s, 'me'), false, 'too small');
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/page.html', mime: 'text/html', fileSize: 5 * MB }, s, 'me'), false, 'not a listed type');
  assert.equal(lib.shouldIntercept({ url: 'blob:https://a.example/123', fileSize: 5 * MB, filename: 'x.zip' }, s, 'me'), false);
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/big.zip', byExtensionId: 'me' }, s, 'me'), false, 'our own fallback');
  assert.equal(lib.shouldIntercept({ url: 'https://bank.example.com/s.pdf', fileSize: 5 * MB }, { ...s, skipHosts: 'example.com' }, 'me'), false);
  assert.equal(lib.shouldIntercept({ url: 'https://a.example/big.zip' }, { ...s, key: '' }, 'me'), false, 'not connected');
  assert.equal(lib.classifyResponse('https://c.example/master.m3u8?x=1', 'application/vnd.apple.mpegurl', 900), 'hls');
  assert.equal(lib.classifyResponse('https://c.example/v.mpd', 'application/dash+xml', 0), 'dash');
  assert.equal(lib.classifyResponse('https://c.example/seg12.ts', 'video/mp2t', 900000), null);
  assert.equal(lib.classifyResponse('https://c.example/clip.mp4', 'video/mp4', 50000), null, 'tiny clip');
  assert.equal(lib.classifyResponse('https://c.example/clip.mp4', 'video/mp4', 5 * MB), 'video');
});

// Load background.js like Chrome would, with chrome.* stand-ins that record what it does.
function loadBackground({ settings, cookies = [] }) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const did = [];
  const store = { ...lib.DEFAULTS, ...settings };
  const session = {};
  const chrome = {
    runtime: { id: 'self-id', onInstalled: on('installed'), onMessage: on('message'), openOptionsPage() {} },
    storage: {
      local: { get: async (d) => ({ ...d, ...store }), set: async (o) => Object.assign(store, o) },
      session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, o), remove: async (k) => { delete session[k]; } },
    },
    cookies: { getAll: async () => cookies },
    contextMenus: { removeAll: (cb) => cb && cb(), create: (o) => did.push(['menu', o.id]), onClicked: on('menu') },
    downloads: {
      onCreated: on('created'),
      cancel: async (id) => did.push(['cancel', id]), erase: async (q) => did.push(['erase', q.id]),
      download: (o) => did.push(['browserDownload', o.url]),
    },
    action: { setBadgeText: (o) => did.push(['badge', o.text]), setBadgeBackgroundColor() {} },
    webRequest: { onHeadersReceived: on('headers') },
    tabs: { onUpdated: on('tabUpdated'), onRemoved: on('tabRemoved') },
  };
  const dir = path.join(__dirname, '..', 'browser-extension');
  const context = vm.createContext({ chrome, fetch, setTimeout, console, URL, globalThis: null });
  context.globalThis = context;
  context.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context);
  return { listeners, did, session };
}

async function novadm(t) {
  const store = { apiEnabled: true, apiPort: 0, apiKey: 'pair-key' };
  const added = [];
  const api = new LocalApi({
    settings: { get: (k) => store[k], set: (p) => Object.assign(store, p) },
    downloads: { add: (s) => { added.push(['start', s]); return { id: 'x' }; }, list: () => [], activeSummary: () => ({}) },
    addFlow: { request: (s) => { added.push(['ask', s]); return { ok: true, pending: true }; } },
    version: '0.7.0',
  });
  const { port } = await api.update();
  t.after(() => api.stop());
  return { port, added };
}

const settle = () => new Promise((r) => setTimeout(r, 150));
// Wait for something to happen (the extension's steps are asynchronous and slower under load).
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('right-click "Download link with NovaDM" sends the link, page and cookies', async (t) => {
  const { port, added } = await novadm(t);
  const bg = loadBackground({ settings: { port, key: 'pair-key' }, cookies: [{ name: 'sid', value: 'abc' }] });
  bg.listeners.installed();
  assert.deepEqual(bg.did.filter((d) => d[0] === 'menu').map((d) => d[1]), ['link', 'media']);
  bg.listeners.menu({ menuItemId: 'link', linkUrl: 'https://files.example.com/setup.exe', pageUrl: 'https://files.example.com/download' }, { url: 'https://files.example.com/download' });
  await until(() => added.length > 0);
  assert.equal(added.length, 1);
  assert.equal(added[0][0], 'ask', 'NovaDM shows its dialog');
  assert.equal(added[0][1].url, 'https://files.example.com/setup.exe');
  assert.deepEqual(added[0][1].headers, { referer: 'https://files.example.com/download', cookie: 'sid=abc' });
});

test('a browser download goes to NovaDM; if NovaDM is not there, the browser keeps it', async (t) => {
  const { port, added } = await novadm(t);
  const bg = loadBackground({ settings: { port, key: 'pair-key', intercept: true, minSizeMB: 1 } });
  await bg.listeners.created({ id: 7, url: 'https://cdn.example.com/movie.mkv', filename: 'C:\\Users\\x\\Downloads\\movie.mkv', fileSize: 800 * MB, referrer: 'https://site.example/watch' });
  await until(() => added.length > 0);
  assert.deepEqual(bg.did.filter((d) => ['cancel', 'erase'].includes(d[0])), [['cancel', 7], ['erase', 7]]);
  assert.equal(added[0][1].name, 'movie.mkv');
  assert.equal(added[0][1].size, 800 * MB);

  const off = loadBackground({ settings: { port: 1, key: 'pair-key', intercept: true } }); // nothing listens on port 1
  await off.listeners.created({ id: 8, url: 'https://cdn.example.com/a.zip', fileSize: 5 * MB });
  await until(() => off.did.some((d) => d[0] === 'browserDownload'));
  assert.ok(off.did.some((d) => d[0] === 'browserDownload' && d[1] === 'https://cdn.example.com/a.zip'), 'downloaded by the browser after all');
  await off.listeners.created({ id: 9, url: 'https://cdn.example.com/a.zip', fileSize: 5 * MB });
  assert.ok(!off.did.some((d) => d[0] === 'cancel' && d[1] === 9), 'the fallback download is left alone');
});

test('videos seen on a page are listed per tab and sent from the popup', async (t) => {
  const { port, added } = await novadm(t);
  const bg = loadBackground({ settings: { port, key: 'pair-key' } });
  bg.listeners.headers({ tabId: 3, url: 'https://v.example/hls/master.m3u8', responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }], initiator: 'https://v.example' });
  bg.listeners.headers({ tabId: 3, url: 'https://v.example/hls/seg1.ts', responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }] });
  await settle();
  const list = await new Promise((r) => bg.listeners.message({ type: 'media', tabId: 3 }, {}, r));
  assert.deepEqual(list.list.map((m) => m.kind), ['hls']);
  const sent = await new Promise((r) => bg.listeners.message({ type: 'send', item: { url: list.list[0].url, referer: 'https://v.example/watch' } }, {}, r));
  assert.equal(sent.ok, true);
  assert.equal(added[0][1].kind, 'hls');
  const check = await new Promise((r) => bg.listeners.message({ type: 'check' }, {}, r));
  assert.deepEqual(check, { ok: true, version: '0.7.0', error: '' });
  const wrong = loadBackground({ settings: { port, key: 'bad' } });
  const bad = await new Promise((r) => wrong.listeners.message({ type: 'check' }, {}, r));
  assert.equal(bad.ok, false);
});
