'use strict';
// 1.5: pinned tabs and tab groups — the tab-order rules and what a session keeps.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { COLORS, normalizeOrder, nextColor, cleanGroup } = require('../src/main/tab-groups');
const { TabSession } = require('../src/main/library');

const tabsOf = (spec) => { const m = new Map(spec.map((t) => [t.id, t])); return (id) => m.get(id); };

test('pinned tabs come first, in their own order', () => {
  const tabOf = tabsOf([{ id: 1 }, { id: 2, pinned: true }, { id: 3 }, { id: 4, pinned: true }]);
  assert.deepEqual(normalizeOrder([1, 2, 3, 4], tabOf), [2, 4, 1, 3]);
});

test("a group's tabs stay together, where its first tab is", () => {
  const tabOf = tabsOf([{ id: 1, groupId: 'a' }, { id: 2 }, { id: 3, groupId: 'b' }, { id: 4, groupId: 'a' }, { id: 5, groupId: 'b' }, { id: 6 }]);
  assert.deepEqual(normalizeOrder([1, 2, 3, 4, 5, 6], tabOf), [1, 4, 2, 3, 5, 6]);
  // Already tidy: unchanged; unknown ids dropped.
  assert.deepEqual(normalizeOrder([1, 4, 2, 3, 5, 6], tabOf), [1, 4, 2, 3, 5, 6]);
  assert.deepEqual(normalizeOrder([1, 99, 2], tabOf), [1, 2]);
});

test('a pinned tab is never part of a group run', () => {
  const tabOf = tabsOf([{ id: 1, groupId: 'a' }, { id: 2, pinned: true, groupId: 'a' }, { id: 3, groupId: 'a' }]);
  assert.deepEqual(normalizeOrder([1, 2, 3], tabOf), [2, 1, 3]);
});

test('new groups take the next unused colour; names and colours are cleaned', () => {
  assert.equal(nextColor([]), 'blue');
  assert.equal(nextColor(['blue', 'red']), 'yellow');
  assert.equal(nextColor(COLORS), COLORS[COLORS.length % COLORS.length]);
  assert.deepEqual(cleanGroup({ title: '  Work \n stuff  ', color: 'red', collapsed: 1 }), { title: 'Work stuff', color: 'red', collapsed: true });
  assert.deepEqual(cleanGroup({ title: 'x'.repeat(60), color: 'chartreuse' }), { title: 'x'.repeat(40), color: 'blue', collapsed: false });
});

test('a session keeps pinned tabs and groups; old sessions still load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-session-'));
  try {
    const s = new TabSession(dir);
    s.save([
      { url: 'https://a.example/', title: 'A', pinned: true },
      { url: 'https://b.example/', title: 'B', groupId: 'g7' },
      { url: 'https://c.example/', title: 'C' },
    ], 1, [{ id: 'g7', title: 'Work', color: 'green', collapsed: true }]);
    s.flush();
    const back = new TabSession(dir).load();
    assert.deepEqual(back.tabs, [
      { url: 'https://a.example/', title: 'A', pinned: true },
      { url: 'https://b.example/', title: 'B', group: 'g7' },
      { url: 'https://c.example/', title: 'C' },
    ]);
    assert.deepEqual(back.groups, [{ id: 'g7', title: 'Work', color: 'green', collapsed: true }]);
    assert.equal(back.active, 1);
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ tabs: [{ url: 'https://old.example/', title: 'Old' }], active: 0 }));
    assert.deepEqual(new TabSession(dir).load().groups, [], 'a 1.4 session has no groups');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
