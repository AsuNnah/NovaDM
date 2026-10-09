'use strict';
const api = window.novadm;
const $ = (id) => document.getElementById(id);
let tabs = [];
let activeId = null;
let urlFocused = false;

function call(m, a) { return api.call(m, a); }

// ---- tabs ----
// Tab elements are kept and updated in place (keyed by id). Re-creating them on every update
// would destroy the element under the mouse between mousedown and click.
const tabEls = new Map();

function makeTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.innerHTML = '<span class="inc hidden">◐</span><div class="fav"></div><div class="ttl"></div><div class="cls" title="Close tab (Ctrl+W)"></div>';
  el.querySelector('.cls').innerHTML = xSvg();
  const cls = el.querySelector('.cls');
  // Keep the tab from being selected when the close button is pressed.
  cls.addEventListener('mousedown', (e) => e.stopPropagation());
  cls.addEventListener('click', (e) => { e.stopPropagation(); call('tabs.close', { id }); });
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) call('tabs.select', { id });
    else if (e.button === 1) { e.preventDefault(); call('tabs.close', { id }); }
  });
  el.addEventListener('auxclick', (e) => e.preventDefault());
  return el;
}

function renderTabs() {
  const host = $('tabs');
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  tabs.forEach((t, i) => {
    let el = tabEls.get(t.id);
    if (!el) { el = makeTabEl(t.id); tabEls.set(t.id, el); }
    if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
    el.classList.toggle('active', t.id === activeId);
    el.classList.toggle('discarded', !!t.discarded);
    el.title = t.title || 'New tab';
    el.querySelector('.inc').classList.toggle('hidden', !t.incognito);
    const ttl = el.querySelector('.ttl');
    if (ttl.textContent !== (t.title || 'New tab')) ttl.textContent = t.title || 'New tab';
    const fav = el.querySelector('.fav');
    const favKey = t.loading ? 'loading' : (t.favicon || 'globe');
    if (fav.dataset.key !== favKey) {
      fav.dataset.key = favKey;
      fav.style.backgroundImage = '';
      if (t.loading) fav.innerHTML = '<div class="spin"></div>';
      else if (t.favicon) { fav.innerHTML = ''; fav.style.backgroundImage = `url("${cssUrl(t.favicon)}")`; }
      else fav.innerHTML = globeSvg();
    }
  });
}

function setActive(tab) {
  if (!tab) return;
  activeId = tab.id;
  if (!urlFocused) $('url').value = tab.url || '';
  $('lock').classList.toggle('secure', !!tab.secure);
  $('back').classList.toggle('disabled', !tab.canGoBack);
  $('fwd').classList.toggle('disabled', !tab.canGoForward);
  const web = /^https?:/i.test(tab.url || '');
  $('star-btn').classList.toggle('hidden', !web);
  $('star-btn').classList.toggle('on', !!tab.bookmarked);
  $('star-btn').title = tab.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  $('reader-btn').classList.toggle('hidden', !(web && tab.readable));
  renderTabs();
}

// ---- bookmarks bar ----
let marks = { items: [], showBar: false };
function folderSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>'; }
function renderBar() {
  const bar = $('bmbar');
  bar.classList.toggle('hidden', !marks.showBar);
  if (!marks.showBar) return;
  const host = $('bm-items');
  host.innerHTML = '';
  const chips = [];
  for (const b of marks.items.filter((x) => !x.folder)) {
    const el = document.createElement('div');
    el.className = 'bm';
    el.title = `${b.title}\n${b.url}`;
    const ico = document.createElement('div');
    ico.className = 'ico';
    if (b.icon) ico.style.backgroundImage = `url("${cssUrl(b.icon)}")`; else ico.innerHTML = globeSvg();
    const t = document.createElement('span');
    t.textContent = b.title || b.url;
    el.append(ico, t);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) call('bookmarks.open', { id: b.id, how: e.ctrlKey ? 'tab' : 'here' });
      else if (e.button === 1) { e.preventDefault(); call('bookmarks.open', { id: b.id, how: 'tab' }); }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); call('bookmarks.contextMenu', { id: b.id, x: e.clientX, y: e.clientY }); });
    host.append(el);
    chips.push({ el, id: b.id });
  }
  const folders = [...new Set(marks.items.map((x) => x.folder).filter(Boolean))];
  for (const f of folders) {
    const el = document.createElement('div');
    el.className = 'bm';
    el.innerHTML = `<div class="ico">${folderSvg()}</div>`;
    const t = document.createElement('span');
    t.textContent = f;
    el.append(t);
    el.addEventListener('mousedown', (e) => { if (e.button === 0) { const r = el.getBoundingClientRect(); call('bookmarks.listMenu', { folder: f, x: r.left, y: r.bottom }); } });
    host.append(el);
  }
  // Bookmarks that don't fit go into the » menu.
  const limit = host.getBoundingClientRect().right;
  const hidden = chips.filter((c) => c.el.getBoundingClientRect().right > limit + 0.5);
  for (const c of hidden) c.el.style.visibility = 'hidden';
  const more = $('bm-more');
  more.classList.toggle('hidden', !hidden.length);
  more.onmousedown = (e) => { if (e.button === 0) { const r = more.getBoundingClientRect(); call('bookmarks.listMenu', { ids: hidden.map((c) => c.id), x: r.left, y: r.bottom }); } };
}
api.on('bookmarks', (d) => { marks = d; renderBar(); });
window.addEventListener('resize', () => renderBar());
$('star-btn').onclick = () => call('bookmarks.toggleActive');
$('reader-btn').onclick = () => call('reader.open');

// ---- events from main ----
api.on('tabs', (d) => { tabs = d.tabs; activeId = d.activeId; renderTabs(); const a = tabs.find((t) => t.id === activeId); if (a && !urlFocused) $('url').value = a.url || ''; });
api.on('active-tab', (t) => setActive(t));
api.on('tab-updated', (t) => { const i = tabs.findIndex((x) => x.id === t.id); if (i >= 0) tabs[i] = t; if (t.id === activeId) setActive(t); else renderTabs(); });
api.on('adblock-count', (d) => { $('shield-count').textContent = d.count; });
let lastPopupCount = 0;
api.on('popups-blocked', (d) => {
  const pill = $('popup-pill');
  pill.classList.toggle('hidden', !d.count);
  $('popup-count').textContent = d.count;
  if (d.count > lastPopupCount) { pill.classList.remove('pulse'); void pill.offsetWidth; pill.classList.add('pulse'); }
  lastPopupCount = d.count;
});
$('popup-pill').onclick = () => call('popup.review');
api.on('media', (d) => setBadge('media-badge', d.count));
api.on('downloads', (d) => setBadge('dl-badge', d.summary ? d.summary.active : 0, true));

function setBadge(id, n, gray) {
  const b = $(id);
  if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.classList.remove('hidden'); } else b.classList.add('hidden');
}

// ---- toolbar actions ----
$('back').onclick = () => call('nav.back', {});
$('fwd').onclick = () => call('nav.forward', {});
$('reload').onclick = () => call('nav.reload', {});
$('newtab').onclick = () => call('tabs.new', {});
$('w-min').onclick = () => call('window.minimize');
$('w-max').onclick = () => call('window.maximizeToggle');
$('w-close').onclick = () => call('window.close');

const urlEl = $('url');
// Address bar suggestions (history and bookmarks) are drawn by the overlay, right under the box.
let sugg = [];
let suggIndex = -1;
let typed = '';
let suggTimer = null;
function hideSuggestions() { if (sugg.length) call('omni.hide'); sugg = []; suggIndex = -1; }
function requestSuggestions() {
  clearTimeout(suggTimer);
  suggTimer = setTimeout(async () => {
    const r = $('omnibox').getBoundingClientRect();
    const q = urlEl.value;
    if (!urlFocused || !q.trim()) { hideSuggestions(); return; }
    const res = await call('omni.suggest', { q, left: r.left, width: r.width });
    if (urlEl.value !== q || !urlFocused) return;
    sugg = res.items || [];
    suggIndex = -1;
  }, 60);
}
urlEl.addEventListener('focus', () => { urlFocused = true; $('omnibox').classList.add('focus'); urlEl.select(); });
urlEl.addEventListener('blur', () => {
  urlFocused = false;
  $('omnibox').classList.remove('focus');
  const a = tabs.find((t) => t.id === activeId);
  if (a) urlEl.value = a.url || '';
  // Later than the overlay's mousedown, so a click on a suggestion still counts.
  setTimeout(hideSuggestions, 200);
});
urlEl.addEventListener('input', () => { typed = urlEl.value; requestSuggestions(); });
urlEl.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugg.length) {
    e.preventDefault();
    suggIndex = e.key === 'ArrowDown' ? Math.min(sugg.length - 1, suggIndex + 1) : Math.max(-1, suggIndex - 1);
    urlEl.value = suggIndex >= 0 ? sugg[suggIndex].url : typed;
    call('omni.highlight', { index: suggIndex });
    return;
  }
  if (e.key === 'Enter') {
    let input = suggIndex >= 0 && sugg[suggIndex] ? sugg[suggIndex].url : urlEl.value;
    // Ctrl+Enter: "example" -> www.example.com; Alt+Enter: open in a new tab.
    if (e.ctrlKey && /^[\w-]+$/.test(input.trim())) input = `www.${input.trim()}.com`;
    hideSuggestions();
    if (e.altKey) call('tabs.new', { url: input }); else call('nav.go', { input });
    urlEl.blur();
  }
  if (e.key === 'Escape') { if (sugg.length) { hideSuggestions(); urlEl.value = typed; } else urlEl.blur(); }
});
api.on('omni-done', () => { sugg = []; suggIndex = -1; urlEl.blur(); });

let openPanel = null;
function togglePanel(name) {
  if (openPanel === name) { call('panel.close'); openPanel = null; return; }
  openPanel = name;
  call('panel.open', { name });
}
$('media-btn').onclick = () => togglePanel('media');
$('grab-btn').onclick = () => togglePanel('grabber');
$('dl-btn').onclick = () => togglePanel('downloads');
$('shield-pill').onclick = () => togglePanel('shields');
$('menu-btn').onclick = () => togglePanel('menu');
api.on('close-panel', () => { openPanel = null; });
// Panels can also be opened from inside another panel (e.g. the menu).
api.on('open-panel', (d) => { openPanel = d.name; });
api.on('focus-address', () => { urlEl.focus(); urlEl.select(); });

function cssUrl(u) { return String(u).replace(/["\\]/g, ''); }
function globeSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>'; }
function xSvg() { return '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'; }

call('tabs.list').then((d) => { tabs = d.tabs || []; activeId = d.activeId; renderTabs(); });
call('bookmarks.state').then((d) => { marks = d; renderBar(); });
