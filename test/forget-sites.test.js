'use strict';
// REQ-309 / SEC-109 (1.8.0): a site marked "Forget this site when NovaDM closes" loses its cookies (sub-domains too)
// and its site data; other sites keep theirs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadBrowsing(browser, settings, dir) {
  const stub = (given = {}) => new Proxy(function () {}, { get: (_t, k) => (k in given ? given[k] : k === 'then' ? undefined : stub()), apply: () => undefined });
  const id = require.resolve('electron');
  const saved = require.cache[id];
  const m = new Module(id); m.exports = stub({ app: stub({ isPackaged: false, getPath: () => dir, getAppPath: () => '/app' }) }); m.loaded = true; require.cache[id] = m;
  try {
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main'))) delete require.cache[k];
    return require('../src/main/browsing').setupBrowsing({ settings, browser, net: stub(), userDataDir: dir, sendUI() {}, setPanel() {}, getWindow() {}, relayout() {}, restack() {}, starRect() {} });
  } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
}

test('REQ-309, SEC-109: forgotten sites lose cookies and site data, others keep theirs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-forget-'));
  let jar = [
    { name: 'sid', domain: '.bank.test', path: '/', secure: true },
    { name: 'pref', domain: 'login.bank.test', path: '/app', secure: false },
    { name: 'keep', domain: '.news.test', path: '/', secure: true },
  ];
  const cleared = [];
  let flushed = 0;
  const ses = {
    cookies: {
      get: async () => jar,
      remove: async (url, name) => { const h = new URL(url).hostname; jar = jar.filter((c) => !(c.name === name && c.domain.replace(/^\./, '') === h)); },
      flushStore: async () => { flushed++; },
    },
    clearData: async (o) => { cleared.push(o); },
  };
  const data = { forgetSites: ['bank.test'] };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p), data };
  const browser = new Proxy({ cur: 'normal', normalSession: ses, closedList: () => [], internalTabs: () => [] }, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const b = loadBrowsing(browser, settings, dir);
  b.history.add('https://shop.bank.test/cart', 'Cart');
  b.history.add('https://news.test/', 'News');

  await b.forgetSites();
  assert.deepStrictEqual(jar.map((c) => c.name), ['keep'], 'the site and its sub-domains lost their cookies');
  assert.strictEqual(cleared.length, 1);
  assert.ok(!cleared[0].dataTypes.includes('cookies') && cleared[0].dataTypes.includes('localStorage'));
  for (const o of ['https://bank.test', 'https://www.bank.test', 'http://bank.test', 'https://shop.bank.test']) assert.ok(cleared[0].origins.includes(o), o);
  assert.ok(!cleared[0].origins.some((o) => /news/.test(o)), 'other sites keep their data');
  assert.ok(flushed >= 1, 'written to disk');

  // Nothing marked, or a list that is not a list: nothing is touched.
  cleared.length = 0; data.forgetSites = 'bank.test';
  await b.forgetSites();
  assert.strictEqual(cleared.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
