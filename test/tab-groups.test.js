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
    s.save([{
      tabs: [
        { url: 'https://a.example/', title: 'A', pinned: true },
        { url: 'https://b.example/', title: 'B', groupId: 'g7' },
        { url: 'https://c.example/', title: 'C' },
      ],
      active: 1, groups: [{ id: 'g7', title: 'Work', color: 'green', collapsed: true }],
    }]);
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

// 1.5.0: moving a tab with the keyboard, and the group shortcuts.
const { stepTab } = require('../src/main/tab-groups');
const { shortcutFor } = require('../src/main/shortcuts');

test('Ctrl+Shift+PgUp/PgDn: a tab leaves or enters a group at its edge, jumps folded groups, pinned stay pinned', () => {
  // order: P(pinned) 1 [a: 2 3] 4 [b(folded): 5 6] 7
  const spec = [{ id: 9, pinned: true }, { id: 8, pinned: true }, { id: 1 }, { id: 2, groupId: 'a' }, { id: 3, groupId: 'a' }, { id: 4 }, { id: 5, groupId: 'b' }, { id: 6, groupId: 'b' }, { id: 7 }];
  const tabOf = tabsOf(spec);
  const order = spec.map((t) => t.id);
  const folded = (g) => g === 'b';
  const step = (id, dir) => stepTab(order, tabOf, folded, id, dir);
  assert.deepEqual(step(1, 1), { order, groupId: 'a' }, 'enters the group on its right');
  assert.deepEqual(step(3, 1), { order, groupId: null }, 'the last tab of a group leaves it first');
  assert.deepEqual(step(2, 1), { order: [9, 8, 1, 3, 2, 4, 5, 6, 7], groupId: 'a' }, 'moves inside its group');
  assert.deepEqual(step(4, 1), { order: [9, 8, 1, 2, 3, 5, 6, 4, 7], groupId: null }, 'jumps over a folded group');
  assert.deepEqual(step(7, -1), { order: [9, 8, 1, 2, 3, 4, 7, 5, 6], groupId: null }, 'jumps over it leftwards too');
  assert.equal(step(7, 1), null, 'nothing to the right of the last tab');
  assert.equal(step(1, -1), null, 'an unpinned tab does not move among pinned tabs');
  assert.deepEqual(step(8, -1), { order: [8, 9, 1, 2, 3, 4, 5, 6, 7], groupId: null }, 'pinned tabs move among themselves');
});

test('shortcuts: group keys and moving tabs, without changing the existing ones', () => {
  const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: true, shift: false, alt: false, ...mods });
  assert.equal(shortcutFor(key('K', { shift: true })), 'group-new');
  assert.equal(shortcutFor(key('U', { shift: true })), 'group-remove');
  assert.equal(shortcutFor(key('L', { shift: true })), 'group-fold');
  assert.equal(shortcutFor(key('PageDown', { shift: true })), 'move-tab-right');
  assert.equal(shortcutFor(key('PageUp', { shift: true })), 'move-tab-left');
  assert.equal(shortcutFor(key('PageDown')), 'next-tab');
  assert.equal(shortcutFor(key('G', { shift: true })), 'find-prev');
  assert.equal(shortcutFor(key('k')), 'focus-address');
  assert.equal(shortcutFor(key('k', { alt: true })), null, 'Ctrl+Alt (AltGr) keys stay free for typing');
});

test('1.6: a session keeps every window with its place; the first window is also readable by 1.5', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-session-'));
  try {
    const s = new TabSession(dir);
    s.save([
      { tabs: [{ url: 'https://a.example/', title: 'A' }], active: 0, bounds: { x: 10, y: 20, width: 1200, height: 800 } },
      { tabs: [{ url: 'https://b.example/', title: 'B', groupId: 'g1' }, { url: 'https://c.example/', title: 'C' }], active: 1, groups: [{ id: 'g1', title: 'R', color: 'red' }], bounds: { x: 900, y: 40, width: 800, height: 600 } },
      { tabs: [{ url: 'chrome://settings', title: 'not kept' }], active: 0 }, // nothing that can be reopened: no window
    ]);
    s.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.deepEqual(raw.tabs, [{ url: 'https://a.example/', title: 'A' }], '1.5 reads the top level: the main window');
    const back = new TabSession(dir).load();
    assert.equal(back.windows.length, 2);
    assert.deepEqual(back.windows[1], { tabs: [{ url: 'https://b.example/', title: 'B', group: 'g1' }, { url: 'https://c.example/', title: 'C' }], groups: [{ id: 'g1', title: 'R', color: 'red', collapsed: false }], active: 1, bounds: { x: 900, y: 40, width: 800, height: 600 } });
    assert.deepEqual(back.windows[0].bounds, { x: 10, y: 20, width: 1200, height: 800 });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ tabs: [{ url: 'https://old.example/', title: 'Old' }], active: 0 }));
    const old = new TabSession(dir).load();
    assert.deepEqual(old.windows.map((w) => w.tabs.length), [1], 'a 1.5 session is one window');
    assert.equal(old.windows[0].bounds, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
