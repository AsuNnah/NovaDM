'use strict';
// 1.8.1 fixes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('REQ-303: only the Guard switch rows stretch their first span (1.8.0 pushed list titles right)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/panel.html'), 'utf8');
  assert.doesNotMatch(css, /(^|[}\s])\.srow>span:first-child\{flex:1/m, 'an unscoped rule stretches every row\'s icon');
  assert.match(css, /label\.srow>span:first-child\{flex:1;\}/);
});

test('REQ-315: Cloudflare check pages are not recorded', () => {
  const { recordable } = require('../src/main/library');
  assert.equal(recordable('https://shop.example/item?__cf_chl_tk=abc'), false);
  assert.equal(recordable('https://shop.example/item?id=1&__cf_chl_rt_tk=abc'), false);
  assert.equal(recordable('https://shop.example/item?id=1'), true);
});

test('REQ-315: visits in a row with the same site and title show once, with a count and every id', () => {
  const { collapseVisits } = require('../src/main/library');
  const day = new Date(2026, 10, 15, 18, 0).getTime();
  const v = (id, url, title, t) => ({ id, url, title, t });
  const out = collapseVisits([
    v(5, 'https://search.example/?q=bike&ia=web', 'bike at Search', day + 50),
    v(4, 'https://search.example/?q=bike', 'bike at Search', day + 40),
    v(3, 'https://search.example/?q=bike&t=h_', 'bike at Search', day + 30),
    v(2, 'https://other.example/', 'bike at Search', day + 20),
    v(1, 'https://search.example/?q=bike', 'bike at Search', day - 24 * 3600e3),
  ]);
  assert.deepStrictEqual(out.map((x) => [x.id, x.n, x.ids]), [[5, 3, [5, 4, 3]], [2, 1, [2]], [1, 1, [1]]]);
});

test('Guard off for a site also skips the Shields rewrites there (known bug 2026-11-07)', () => {
  const { AdBlocker } = require('../src/main/adblock');
  const { Shields } = require('../src/main/shields');
  const data = { adblock: true, adblockWhitelist: ['off.example'] };
  const settings = { get: (k) => data[k] };
  const b = Object.create(AdBlocker.prototype);
  Object.assign(b, { settings, shields: new Shields(settings), _ipcDone: true, ready: false, engine: null, phish: null, counts: new Map() });
  let before = null;
  b.attach({ registerPreloadScript() {}, webRequest: { onBeforeRequest: (_f, cb) => { before = cb; }, onHeadersReceived() {} } });
  const run = (url, resourceType, top) => { let r; before({ url, resourceType, method: 'GET', webContents: { isDestroyed: () => false, getURL: () => top || url } }, (x) => { r = x; }); return r; };
  const tracked = (host) => `https://${host}/page?fbclid=x&id=1`;
  assert.deepStrictEqual(run(tracked('off.example'), 'mainFrame'), {}, 'page of a Guard-off site: untouched');
  assert.deepStrictEqual(run(tracked('ads.other.example'), 'subFrame', 'https://off.example/'), {}, 'frame inside a Guard-off site: untouched');
  assert.strictEqual(run('http://off.example/', 'mainFrame').redirectURL, undefined, 'no HTTPS upgrade there');
  assert.strictEqual(run(tracked('on.example'), 'mainFrame').redirectURL, 'https://on.example/page?id=1', 'other sites still cleaned');
});
