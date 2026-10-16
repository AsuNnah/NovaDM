'use strict';
// 1.7.4: regression tests for the bugs found in the 2026-10-16 hunt.
const test = require('node:test');
const assert = require('node:assert');
const { siteOf, sanitizeFilename, filenameFromDisposition, menuText } = require('../src/main/util');
const { parseHtml } = require('../src/main/bookmarks');
const { appMemoryBytes } = require('../src/main/housekeeping');
const { buildContextMenuTemplate } = require('../src/main/contextmenu');

test('siteOf: sites that share a host name are not one site', () => {
  assert.strictEqual(siteOf('https://alice.github.io/x'), 'alice.github.io');
  assert.strictEqual(siteOf('https://bob.github.io/'), 'bob.github.io');
  assert.strictEqual(siteOf('https://www.a.b.pages.dev/'), 'b.pages.dev');
  assert.strictEqual(siteOf('https://shop.myshopify.com/'), 'shop.myshopify.com');
  assert.strictEqual(siteOf('https://x.blogspot.com/2020/'), 'x.blogspot.com');
  assert.strictEqual(siteOf('https://github.io/'), 'github.io');
  assert.strictEqual(siteOf('https://www.wordpress.com/'), 'wordpress.com'); // the company's own site, like the bare name
  // Unchanged cases.
  assert.strictEqual(siteOf('https://www.example.com/'), 'example.com');
  assert.strictEqual(siteOf('https://a.b.example.co.uk/'), 'example.co.uk');
  assert.strictEqual(siteOf('https://news.example.co.id/'), 'example.co.id');
  assert.strictEqual(siteOf('https://user.my.id/'), 'user.my.id');
  assert.strictEqual(siteOf('http://127.0.0.1:8080/'), '127.0.0.1');
  assert.strictEqual(siteOf('http://localhost:3000/'), 'localhost');
  assert.strictEqual(siteOf('not a url'), '');
});

test('sanitizeFilename: text-direction tricks and invisible characters are removed', () => {
  assert.strictEqual(sanitizeFilename('invoice‮gpj.exe'), 'invoicegpj.exe');
  assert.strictEqual(sanitizeFilename('a​b⁦c⁩.txt'), 'abc.txt');
  assert.strictEqual(sanitizeFilename('﻿name.mp4'), 'name.mp4');
  // Persian needs the zero-width non-joiner, emoji the joiner.
  assert.strictEqual(sanitizeFilename('می‌خواهم.txt'), 'می‌خواهم.txt');
  assert.strictEqual(sanitizeFilename('con.'), '_con');
});

test('filenameFromDisposition: other charsets in filename*', () => {
  assert.strictEqual(filenameFromDisposition("attachment; filename*=iso-8859-1''caf%E9.txt"), 'café.txt');
  assert.strictEqual(filenameFromDisposition("attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.mp4"), '日本.mp4');
  assert.strictEqual(filenameFromDisposition('attachment; filename="a b.mp4"'), 'a b.mp4');
});

test('menuText: a literal & is doubled for Windows menus', () => {
  assert.strictEqual(menuText('News & more'), 'News && more');
  assert.strictEqual(menuText('a && b'), 'a &&&& b');
  assert.strictEqual(menuText(null), '');
});

test('bookmarks HTML: entities, single quotes and unquoted addresses', () => {
  const t = parseHtml(`<DL><DT><A HREF="https://a.example/">It&#8217;s &amp; &#x41;&nbsp;&copy; &bogus;</A>
    <DT><a href='https://single.example/'>Single</a><DT><A HREF=https://bare.example/x>Bare</A></DL>`);
  const items = t.other;
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].title, 'It’s & A © &bogus;');
  assert.strictEqual(items[1].url, 'https://single.example/');
  assert.strictEqual(items[2].url, 'https://bare.example/x');
});

test('memory protection counts private memory, not shared working sets', () => {
  const KB = 1024;
  assert.strictEqual(appMemoryBytes([{ memory: { workingSetSize: 73 * 1024, privateBytes: 24 * 1024 } }, { memory: { workingSetSize: 100 * 1024 } }]), (24 + 100) * 1024 * KB);
});

test('context menu: spelling corrections, and links open next to the page', () => {
  const calls = [];
  const wc = { replaceMisspelling: (w) => calls.push(['fix', w]), session: { addWordToSpellCheckerDictionary: (w) => calls.push(['add', w]) }, navigationHistory: { canGoBack: () => false, canGoForward: () => false } };
  const tab = { id: 7, url: 'https://a.example/', wc, incognito: false };
  const browser = { createTab: (o) => calls.push(['tab', o]) };
  const settings = { get: () => undefined, searchUrl: (q) => 'https://s.example/?q=' + q };
  const ctx = (params) => buildContextMenuTemplate({ tab, params, browser, downloads: {}, settings, extensions: null });

  const edit = ctx({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tee', 'six'], editFlags: {} });
  const labels = edit.map((i) => i.label || '-');
  assert.deepStrictEqual(labels.slice(0, 7), ['the', 'tea', 'ten', 'tech', 'tee', 'Add to dictionary', '-']); // five corrections at most
  edit[0].click(); edit.find((i) => i.label === 'Add to dictionary').click();
  assert.deepStrictEqual(calls.slice(0, 2), [['fix', 'the'], ['add', 'teh']]);
  assert.ok(ctx({ isEditable: true, misspelledWord: 'zzzz', dictionarySuggestions: [], editFlags: {} }).some((i) => i.label === 'No spelling suggestions'));
  assert.ok(!ctx({ isEditable: true, editFlags: {} }).some((i) => i.label === 'Add to dictionary')); // no misspelling: no extra items

  calls.length = 0;
  ctx({ linkURL: 'https://l.example/' }).find((i) => i.label === 'Open link in new tab').click();
  assert.strictEqual(calls[0][1].openerPartition, 7);
  const sel = ctx({ selectionText: 'Tom & Jerry' }).find((i) => /^Search for/.test(i.label || ''));
  assert.ok(sel.label.includes('Tom && Jerry'));
});
