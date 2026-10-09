'use strict';
// Keyboard shortcuts (Brave / Chrome set), for pages and for NovaDM's toolbar alike.
// input: Electron's before-input-event input. Returns an action name or null.
function shortcutFor(input) {
  if (!input || input.type !== 'keyDown') return null;
  const ctrl = input.control || input.meta;
  const shift = input.shift;
  const alt = input.alt;
  const k = String(input.key || '').toLowerCase();
  if (ctrl && !alt) {
    if (k === '=' || k === '+') return 'zoom-in';
    if (k === '-') return 'zoom-out';
    if (k === '0') return 'zoom-reset';
    if (/^[1-8]$/.test(k) && !shift) return 'tab-' + k;
    if (k === '9' && !shift) return 'tab-last';
    if (k === 'tab') return shift ? 'prev-tab' : 'next-tab';
    if (k === 'pagedown') return 'next-tab';
    if (k === 'pageup') return 'prev-tab';
    if (k === 'f4') return 'close-tab';
    if (k === 'delete' && shift) return 'clear-data';
    if (k === '/' || k === '?') return 'shortcut-list';
    if (shift) {
      return {
        t: 'reopen-tab', n: 'new-private', w: 'close-window', r: 'hard-reload', d: 'bookmark-all', b: 'bookmarks-bar',
        o: 'bookmarks', i: 'devtools', j: 'devtools', c: 'devtools', g: 'find-prev',
      }[k] || null;
    }
    return {
      t: 'new-tab', n: 'new-tab', w: 'close-tab', l: 'focus-address', k: 'focus-address', e: 'focus-address', j: 'downloads',
      r: 'reload', f: 'find', g: 'find-next', d: 'bookmark', h: 'history', p: 'print', s: 'save-page', o: 'open-file', u: 'view-source',
    }[k] || null;
  }
  if (alt && !ctrl) {
    if (k === 'arrowleft') return 'back';
    if (k === 'arrowright') return 'forward';
    if (k === 'home') return 'home';
    if (k === 'd') return 'focus-address';
    if (k === 'f' || k === 'e') return 'menu';
    return null;
  }
  if (ctrl || alt) return null;
  if (k === 'f5') return shift ? 'hard-reload' : 'reload';
  if (k === 'f3') return shift ? 'find-prev' : 'find-next';
  if (k === 'f6') return 'focus-address';
  if (k === 'f10') return 'menu';
  if (k === 'f11') return 'fullscreen';
  if (k === 'f12') return 'devtools';
  if (k === 'escape' && shift) return 'task-manager';
  if (k === 'escape') return 'stop'; // only taken when the page is loading (see main.js)
  return null;
}

const LIST = [
  ['Tabs', 'Ctrl+T / Ctrl+N new tab · Ctrl+Shift+N private tab · Ctrl+W close · Ctrl+Shift+T reopen closed tab · Ctrl+Tab / Ctrl+PgDn next · Ctrl+Shift+Tab / Ctrl+PgUp previous · Ctrl+1…8 tab n · Ctrl+9 last tab · Ctrl+Shift+W close window'],
  ['Address bar', 'Ctrl+L / Alt+D / F6 / Ctrl+K / Ctrl+E go to the address bar · Ctrl+Enter add www. and .com · Alt+Enter open in a new tab'],
  ['Page', 'Alt+← / Alt+→ back / forward · F5 / Ctrl+R reload · Shift+F5 / Ctrl+Shift+R reload without cache · Esc stop · Alt+Home home page · F11 full screen · Ctrl+P print · Ctrl+S save page · Ctrl+O open a file · Ctrl + / − / 0 or Ctrl+wheel zoom'],
  ['Find', 'Ctrl+F find · F3 / Ctrl+G next · Shift+F3 / Ctrl+Shift+G previous'],
  ['Bookmarks and history', 'Ctrl+D bookmark · Ctrl+Shift+D bookmark all tabs · Ctrl+Shift+B bookmarks bar · Ctrl+Shift+O bookmarks · Ctrl+H history · Ctrl+J downloads · Ctrl+Shift+Delete clear browsing data'],
  ['Tools', 'F12 / Ctrl+Shift+I / J / C developer tools · Ctrl+U page source · Shift+Esc task manager · Alt+F / F10 menu · Ctrl+/ this list'],
  ['Mouse', 'Ctrl+click background tab · middle-click new tab · Alt+click download the link with NovaDM'],
];

module.exports = { shortcutFor, LIST };
