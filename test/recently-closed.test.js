'use strict';
// 1.7.14: the History panel's Recently closed list: a time on each entry, reopen a chosen one, nothing private.
const test = require('node:test');
const assert = require('node:assert');
const { Browser } = require('../src/main/browser');

test('recently closed: newest first with times, a chosen entry reopens, a private window gets nothing', () => {
  const opened = [];
  const b = {
    closed: [], cur: 'w1', tabs: new Map(),
    createTab({ url, title }) { const id = opened.length + 1; opened.push({ url, title }); this.tabs.set(id, {}); return id; },
    selectTab() {},
  };
  const P = Browser.prototype;
  const before = Date.now();
  P.rememberClosed.call(b, { url: 'https://a.test/', title: 'A' });
  P.rememberClosed.call(b, { window: { bounds: {}, groups: [], tabs: [{ url: 'https://w.test/', title: 'W' }, { url: 'https://w.test/2', title: 'W2' }] } });
  P.rememberClosed.call(b, { url: 'https://c.test/', title: 'C' });

  const list = P.closedList.call(b, false);
  assert.deepStrictEqual(list.map((c) => c.title), ['C', 'W', 'A']);
  assert.ok(list.every((c) => c.t >= before && c.id), 'each entry has a time and an id');
  assert.deepStrictEqual([list[1].window, list[1].tabs], [true, 2]);
  assert.deepStrictEqual(P.closedList.call(b, true), [], 'a private window sees nothing');
  assert.strictEqual(P.reopenClosed.call(b, true, list[2].id), null);

  P.reopenClosed.call(b, false, list[2].id); // A, not the last one closed
  assert.deepStrictEqual(opened.map((o) => o.title), ['A']);
  assert.deepStrictEqual(P.closedList.call(b, false).map((c) => c.title), ['C', 'W']);
  P.reopenClosed.call(b, false); // Ctrl+Shift+T: still the last one
  assert.deepStrictEqual(opened.map((o) => o.title), ['A', 'C']);
  assert.strictEqual(P.reopenClosed.call(b, false, 999), null, 'an entry already reopened');

  for (let i = 0; i < 30; i++) P.rememberClosed.call(b, { url: `https://n${i}.test/`, title: 'n' + i });
  assert.strictEqual(b.closed.length, 25);
});
