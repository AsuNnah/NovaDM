'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shortcutFor } = require('../src/main/shortcuts');

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...mods });
const ctrl = (k, extra = {}) => key(k, { control: true, ...extra });

test('shortcuts: every key combination maps to its action', () => {
  const table = [
    [ctrl('Tab'), 'next-tab'], [ctrl('Tab', { shift: true }), 'prev-tab'], [ctrl('PageDown'), 'next-tab'], [ctrl('PageUp'), 'prev-tab'],
    [ctrl('PageDown', { shift: true }), 'move-tab-right'], [ctrl('PageUp', { shift: true }), 'move-tab-left'],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [ctrl(String(n)), 'tab-' + n]), [ctrl('9'), 'tab-last'],
    [ctrl('t'), 'new-tab'], [ctrl('n'), 'new-window'], [ctrl('w'), 'close-tab'], [ctrl('F4'), 'close-tab'],
    [ctrl('T', { shift: true }), 'reopen-tab'], [ctrl('N', { shift: true }), 'new-private'], [ctrl('W', { shift: true }), 'close-window'],
    [ctrl('l'), 'focus-address'], [ctrl('k'), 'focus-address'], [ctrl('e'), 'focus-address'], [key('d', { alt: true }), 'focus-address'], [key('F6'), 'focus-address'],
    [ctrl('j'), 'downloads'], [ctrl('h'), 'history'], [ctrl('O', { shift: true }), 'bookmarks'], [ctrl('d'), 'bookmark'], [ctrl('D', { shift: true }), 'bookmark-all'], [ctrl('B', { shift: true }), 'bookmarks-bar'],
    [ctrl('Delete', { shift: true }), 'clear-data'], [ctrl('/'), 'shortcut-list'], [ctrl('?', { shift: true }), 'shortcut-list'],
    [ctrl('r'), 'reload'], [key('F5'), 'reload'], [key('F5', { shift: true }), 'hard-reload'], [ctrl('R', { shift: true }), 'hard-reload'],
    [ctrl('f'), 'find'], [ctrl('g'), 'find-next'], [key('F3'), 'find-next'], [key('F3', { shift: true }), 'find-prev'], [ctrl('G', { shift: true }), 'find-prev'],
    [ctrl('p'), 'print'], [ctrl('s'), 'save-page'], [ctrl('o'), 'open-file'], [ctrl('u'), 'view-source'],
    [key('F12'), 'devtools'], [ctrl('I', { shift: true }), 'devtools'], [ctrl('J', { shift: true }), 'devtools-console'], [ctrl('C', { shift: true }), 'devtools-inspect'],
    [ctrl('A', { shift: true }), 'tab-search'], [key('f', { alt: true }), 'menu'], [key('F10'), 'menu'], [key('Escape', { shift: true }), 'task-manager'], [key('Escape'), 'stop'],
    [key('ArrowLeft', { alt: true }), 'back'], [key('ArrowRight', { alt: true }), 'forward'], [key('Home', { alt: true }), 'home'], [key('F11'), 'fullscreen'],
    [ctrl('='), 'zoom-in'], [ctrl('+', { shift: true }), 'zoom-in'], [ctrl('-'), 'zoom-out'], [ctrl('0'), 'zoom-reset'],
    [ctrl('K', { shift: true }), 'group-new'], [ctrl('U', { shift: true }), 'group-remove'], [ctrl('L', { shift: true }), 'group-fold'],
  ];
  for (const [input, action] of table) assert.strictEqual(shortcutFor(input), action, JSON.stringify(input));
  // Case of the letter (Caps Lock, Shift) doesn't matter, the Windows key counts as Ctrl on other systems' events,
  // and ordinary typing, key releases and unknown combinations are left alone.
  assert.strictEqual(shortcutFor(ctrl('J')), 'downloads');
  assert.strictEqual(shortcutFor(key('j', { meta: true })), 'downloads');
  assert.strictEqual(shortcutFor({ ...ctrl('j'), type: 'keyUp' }), null);
  assert.strictEqual(shortcutFor(key('j')), null);
  assert.strictEqual(shortcutFor(ctrl('q')), null);
  assert.strictEqual(shortcutFor(null), null);
});
