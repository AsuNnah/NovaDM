'use strict';
// 1.7.14: the toolbar runs sandboxed, so its preload is generated with the extension-button module joined in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { build } = require('../tools/build-ui-preload');

test('the toolbar preload needs nothing but electron, and gives the toolbar its extension buttons', () => {
  const src = fs.readFileSync(build(), 'utf8');
  new vm.Script(src); // parses
  const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(required)], ['electron']);
  // Run it as a sandboxed preload would: require() knows only 'electron'.
  const exposed = {};
  let mainWorld = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; }, executeInMainWorld: (o) => { mainWorld = o; } },
    ipcRenderer: { setMaxListeners() {}, invoke: async () => ({}), on() {}, removeListener() {} },
    webFrame: { executeJavaScript: async () => {} },
  };
  const ctx = {
    require: (n) => { if (n !== 'electron') throw new Error('not in a sandbox: ' + n); return electron; },
    location: { href: 'app://ui/chrome.html', pathname: '/chrome.html', search: '' }, URLSearchParams, process: Object.assign(new (require('events'))(), { contextIsolated: true, sandboxed: true }),
    console, queueMicrotask, document: { documentElement: {} }, window: {},
  };
  vm.runInNewContext(src, ctx);
  assert.ok(exposed.novadm, 'NovaDM bridge exposed');
  assert.ok(exposed.browserAction, 'extension-button API exposed to the toolbar');
  assert.strictEqual(typeof (mainWorld && mainWorld.func), 'function', 'the <browser-action-list> element is defined in the page');
});
