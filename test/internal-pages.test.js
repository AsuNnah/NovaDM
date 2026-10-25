'use strict';
// 1.7.7: Settings, Downloads, Bookmarks and History are open once per window; which addresses count as those pages.
const test = require('node:test');
const assert = require('node:assert');
const { onePerWindow } = require('../src/main/browser');

test('the four pages are recognised, with or without a section, query or trailing slash', () => {
  for (const [url, page] of [
    ['novadm://settings', 'settings'], ['novadm://settings?section=about', 'settings'], ['novadm://settings/', 'settings'],
    ['novadm://downloads', 'downloads'], ['novadm://bookmarks#x', 'bookmarks'], ['novadm://history?clear=1', 'history'], ['NOVADM://Settings', 'settings'],
  ]) assert.strictEqual(onePerWindow(url), page, url);
});

test('everything else is a new tab every time: the new-tab page, the reader view, look-alikes and real web pages', () => {
  for (const url of [
    'novadm://newtab', 'novadm://reader?url=https://example.com/', 'novadm://settingsx', 'novadm://settings.evil/', 'novadm://history/../x',
    'https://example.com/novadm://settings', 'https://settings.example/', 'http://127.0.0.1/downloads', 'javascript:novadm://settings', '', undefined, null,
  ]) assert.strictEqual(onePerWindow(url), '', String(url));
});
