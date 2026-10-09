'use strict';
const api = window.swoop;
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
  renderTabs();
}

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
api.on('window-state', () => {});

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
urlEl.addEventListener('focus', () => { urlFocused = true; $('omnibox').classList.add('focus'); urlEl.select(); });
urlEl.addEventListener('blur', () => { urlFocused = false; $('omnibox').classList.remove('focus'); const a = tabs.find((t) => t.id === activeId); if (a) urlEl.value = a.url || ''; });
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { call('nav.go', { input: urlEl.value }); urlEl.blur(); }
  if (e.key === 'Escape') { urlEl.blur(); }
});

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

// keyboard shortcuts (chrome view has focus often)
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 't') { call('tabs.new', {}); e.preventDefault(); }
  else if (ctrl && e.key === 'w') { if (activeId != null) call('tabs.close', { id: activeId }); e.preventDefault(); }
  else if (ctrl && e.key === 'l') { urlEl.focus(); e.preventDefault(); }
  else if (ctrl && e.key === 'r') { call('nav.reload', {}); e.preventDefault(); }
  else if (ctrl && e.key === 'j') { call('downloads.openPageTab'); e.preventDefault(); }
});

function cssUrl(u) { return String(u).replace(/["\\]/g, ''); }
function globeSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>'; }
function xSvg() { return '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'; }

call('tabs.list').then((d) => { tabs = d.tabs || []; activeId = d.activeId; renderTabs(); });
