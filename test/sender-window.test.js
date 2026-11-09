'use strict';
// SEC-110 (1.8.0): the History page in a private window lists nothing and changes nothing in the normal history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadBrowsing(browser, dir) {
  const stub = (given = {}) => new Proxy(function () {}, { get: (_t, k) => (k in given ? given[k] : k === 'then' ? undefined : stub()), apply: () => undefined });
  const id = require.resolve('electron');
  const saved = require.cache[id];
  const m = new Module(id); m.exports = stub({ app: stub({ isPackaged: false, getPath: () => dir, getAppPath: () => '/app' }) }); m.loaded = true; require.cache[id] = m;
  try {
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main'))) delete require.cache[k];
    const { setupBrowsing } = require('../src/main/browsing');
    return setupBrowsing({ settings: stub({ get: () => undefined, data: {} }), browser, net: stub(), userDataDir: dir, sendUI() {}, setPanel() {}, getWindow() {}, relayout() {}, restack() {}, starRect() {} });
  } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
}

test('SEC-110: a private window\'s History page gets no visits and can\'t remove, clear or open from the normal history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-hist-'));
  const opened = [];
  const browser = new Proxy({ cur: 'normal', activeId: 1, navigate: (_id, url) => opened.push(url), createTab: ({ url }) => opened.push(url), closedList: () => [], internalTabs: () => [] }, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
  });
  const b = loadBrowsing(browser, dir);
  b.history.add('https://a.test/one', 'One');
  const id = b.history.visits[0].id;

  browser.cur = 'private';
  assert.deepStrictEqual(b.handlers['history.search']({}), { private: true, items: [] });
  b.handlers['history.remove']({ ids: [id] });
  await b.handlers['history.clear']({ history: true });
  b.handlers['history.open']({ url: 'https://a.test/one' });
  assert.strictEqual(b.history.visits.length, 1, 'nothing removed or cleared from a private window');
  assert.deepStrictEqual(opened, []);

  browser.cur = 'normal';
  assert.deepStrictEqual(b.handlers['history.search']({}).items.map((v) => v.title), ['One']);
  b.handlers['history.remove']({ ids: [id] });
  assert.strictEqual(b.history.visits.length, 0, 'the normal window still removes');
  fs.rmSync(dir, { recursive: true, force: true });
});
