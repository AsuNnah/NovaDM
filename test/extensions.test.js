'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeUrl } = require('../src/main/address');
const { usesDnr, optionsPageOf } = require('../src/main/extension-manifest');

const settings = { searchUrl: (q) => 'https://search.example/?q=' + encodeURIComponent(q) };
const ID = 'epcnnfbjfcgphgdmggkamkmgojdagdnn';

test('an extension page keeps its chrome-extension:// address', () => {
  assert.strictEqual(normalizeUrl(`chrome-extension://${ID}/options.html`, settings), `chrome-extension://${ID}/options.html`);
  assert.strictEqual(normalizeUrl(`chrome-extension://${ID}/`, settings), `chrome-extension://${ID}/`);
});

test('other addresses are unchanged by that rule', () => {
  assert.strictEqual(normalizeUrl('example.com/a', settings), 'https://example.com/a');
  assert.strictEqual(normalizeUrl('chrome-extension://nope/options.html', settings), 'https://chrome-extension://nope/options.html'); // not a real extension id: as before
  assert.strictEqual(normalizeUrl('hello world', settings), 'https://search.example/?q=hello%20world');
  assert.strictEqual(normalizeUrl('', settings), 'novadm://newtab');
});

test('declarativeNetRequest extensions are recognised', () => {
  assert.strictEqual(usesDnr({ permissions: ['storage', 'declarativeNetRequest'] }), true);
  assert.strictEqual(usesDnr({ permissions: ['declarativeNetRequestWithHostAccess'] }), true);
  assert.strictEqual(usesDnr({ permissions: ['storage', 'webRequest'] }), false);
  assert.strictEqual(usesDnr(undefined), false);
});

test('options page from options_page or options_ui', () => {
  assert.strictEqual(optionsPageOf({ options_page: 'a.html' }), 'a.html');
  assert.strictEqual(optionsPageOf({ options_ui: { page: 'b.html' } }), 'b.html');
  assert.strictEqual(optionsPageOf({}), '');
});
