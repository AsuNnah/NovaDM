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
const chipEls = new Map(); // tab group id -> its chip (name and colour, before the group's tabs)
let dragId = null; // the tab being dragged
let dragGroup = null; // or the group being dragged (by its chip)

function makeTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.draggable = true;
  el.innerHTML = '<span class="inc hidden">◐</span><div class="fav"></div><div class="ttl"></div><span class="mut hidden"></span><div class="cls" title="Close tab (Ctrl+W)"></div>';
  el.querySelector('.cls').innerHTML = xSvg();
  el.querySelector('.mut').innerHTML = mutedSvg();
  const cls = el.querySelector('.cls');
  // Keep the tab from being selected when the close button is pressed.
  cls.addEventListener('mousedown', (e) => e.stopPropagation());
  cls.addEventListener('click', (e) => { e.stopPropagation(); call('tabs.close', { id }); });
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) call('tabs.select', { id });
    else if (e.button === 1) { e.preventDefault(); call('tabs.close', { id }); }
  });
  el.addEventListener('auxclick', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); call('tabs.contextMenu', { id, x: e.clientX, y: e.clientY }); });
  // Drag and drop: the tab goes before or after the tab it is dropped on, into that tab's group.
  el.addEventListener('dragstart', (e) => { dragId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(TAB_TYPE, String(id)); el.classList.add('dragging'); });
  el.addEventListener('dragend', (e) => {
    // Dropped where nothing takes it, away from the strip: the tab goes to a new window there.
    if (droppedOutside(e)) call('tabs.detach', { id, x: e.screenX, y: e.screenY });
    dragId = null; el.classList.remove('dragging'); clearDropMarks();
  });
  // Not a drop target for itself, or for the group being dragged when it is one of its tabs.
  const accepts = (e) => {
    if (fromOtherWindow(e)) return true;
    if (dragId != null) return dragId !== id;
    if (dragGroup == null) return false;
    const t = tabs.find((x) => x.id === id);
    return !(t && t.group && t.group.id === dragGroup);
  };
  el.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    el.classList.add(dropAfter(e, el) ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = tabs.find((t) => t.id === id);
    const remote = fromOtherWindow(e);
    if (remote === TAB_TYPE) call('tabs.moveHere', { id: Number(e.dataTransfer.getData(TAB_TYPE)), index: tabs.findIndex((t) => t.id === id) + (dropAfter(e, el) ? 1 : 0), groupId: target && target.group ? target.group.id : null });
    else if (remote === GROUP_TYPE) call('tabs.moveGroupHere', { id: e.dataTransfer.getData(GROUP_TYPE), index: groupDropIndex('', target, dropAfter(e, el)) });
    else if (dragGroup != null) call('tabs.moveGroup', { id: dragGroup, index: groupDropIndex(dragGroup, target, dropAfter(e, el)) });
    else {
      const rest = tabs.filter((t) => t.id !== dragId);
      const index = rest.findIndex((t) => t.id === id) + (dropAfter(e, el) ? 1 : 0);
      call('tabs.move', { id: dragId, index, groupId: target && target.group ? target.group.id : null });
    }
    clearDropMarks();
  });
  return el;
}
const dropAfter = (e, el) => { const r = el.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
// Drags between windows (1.6): the tab or group id travels in the drag data; main checks it.
const TAB_TYPE = 'application/x-novadm-tab';
const GROUP_TYPE = 'application/x-novadm-group';
/** TAB_TYPE / GROUP_TYPE when a drag comes from another window's strip, else ''. */
function fromOtherWindow(e) {
  if (dragId != null || dragGroup != null || !e.dataTransfer) return '';
  const types = [...e.dataTransfer.types];
  return types.includes(TAB_TYPE) ? TAB_TYPE : types.includes(GROUP_TYPE) ? GROUP_TYPE : '';
}
/** A drag that ended with no drop, away from the toolbar (on the page or outside the window). */
function droppedOutside(e) {
  if (!e.dataTransfer || e.dataTransfer.dropEffect !== 'none') return false;
  return e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight;
}
/** Where a dragged group goes (index in the order without its tabs): beside the target tab, or
 * beside the target's whole group, so a group is never split. No target: at the end. */
function groupDropIndex(gid, target, after) {
  const rest = tabs.filter((t) => !(t.group && t.group.id === gid));
  if (!target) return rest.length;
  const ids = target.group ? rest.filter((t) => t.group && t.group.id === target.group.id).map((t) => t.id) : [target.id];
  return after ? rest.findIndex((t) => t.id === ids[ids.length - 1]) + 1 : rest.findIndex((t) => t.id === ids[0]);
}
function clearDropMarks() { for (const x of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into'); }

function makeChipEl(gid) {
  const el = document.createElement('div');
  el.className = 'tgroup';
  el.dataset.gid = gid;
  el.draggable = true;
  el.innerHTML = '<span class="gname"></span>';
  // Drag the chip to move the whole group.
  el.addEventListener('dragstart', (e) => {
    if (el.querySelector('input')) { e.preventDefault(); return; }
    dragGroup = gid; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(GROUP_TYPE, gid); el.classList.add('dragging');
  });
  el.addEventListener('dragend', (e) => {
    if (droppedOutside(e)) call('tabs.detachGroup', { id: gid, x: e.screenX, y: e.screenY }); // tear the group off into a new window
    dragGroup = null; el.classList.remove('dragging'); clearDropMarks();
  });
  el.addEventListener('mousedown', (e) => { if (e.button === 0 && !el.querySelector('input')) e.preventDefault(); });
  el.addEventListener('click', () => {
    if (el.querySelector('input')) return;
    const g = groupOf(gid);
    if (g) call('tabs.groupUpdate', { id: gid, collapsed: !g.collapsed });
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); call('tabs.groupMenu', { id: gid, x: e.clientX, y: e.clientY }); });
  el.addEventListener('dblclick', () => editGroup(gid));
  // A tab dropped on the chip joins the group, at its end; another group dropped on it goes before it.
  el.addEventListener('dragover', (e) => {
    const remote = fromOtherWindow(e);
    if (!remote && dragId == null && (dragGroup == null || dragGroup === gid)) return;
    e.preventDefault(); e.stopPropagation(); clearDropMarks();
    el.classList.add(dragId != null || remote === TAB_TYPE ? 'drop-into' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    const remote = fromOtherWindow(e);
    if (!remote && dragId == null && (dragGroup == null || dragGroup === gid)) return;
    e.preventDefault(); e.stopPropagation();
    const members = tabs.filter((t) => t.group && t.group.id === gid);
    if (remote === TAB_TYPE) call('tabs.moveHere', { id: Number(e.dataTransfer.getData(TAB_TYPE)), index: tabs.indexOf(members[members.length - 1]) + 1, groupId: gid });
    else if (remote === GROUP_TYPE) call('tabs.moveGroupHere', { id: e.dataTransfer.getData(GROUP_TYPE), index: tabs.indexOf(members[0]) });
    else if (dragId != null) call('tabs.addToGroup', { id: dragId, groupId: gid });
    else call('tabs.moveGroup', { id: dragGroup, index: groupDropIndex(dragGroup, tabs.find((t) => t.group && t.group.id === gid), false) });
    clearDropMarks();
  });
  return el;
}
const groupOf = (gid) => (tabs.find((t) => t.group && t.group.id === gid) || {}).group || null;

/** Type the group's name in its chip (Enter keeps it, Esc cancels). */
function editGroup(gid) {
  const chip = chipEls.get(gid);
  const g = groupOf(gid);
  if (!chip || !g || chip.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'gedit';
  input.maxLength = 40;
  input.value = g.title || '';
  input.placeholder = 'Name this group';
  input.setAttribute('aria-label', 'Group name');
  chip.querySelector('.gname').replaceWith(input);
  chip.classList.add('editing');
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const span = document.createElement('span');
    span.className = 'gname';
    input.replaceWith(span);
    chip.classList.remove('editing');
    if (save) call('tabs.groupUpdate', { id: gid, title: input.value });
    renderTabs();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}
api.on('group-edit', (d) => setTimeout(() => editGroup(d.id), 0));

function renderTabs() {
  const host = $('tabs');
  // The strip: each group's chip before its first tab, then the tabs.
  const els = [];
  const groups = new Set();
  tabs.forEach((t, i) => {
    const g = t.group;
    if (g && (i === 0 || !tabs[i - 1].group || tabs[i - 1].group.id !== g.id)) {
      let chip = chipEls.get(g.id);
      if (!chip) { chip = makeChipEl(g.id); chipEls.set(g.id, chip); }
      chip.style.setProperty('--gc', g.hex);
      chip.classList.toggle('collapsed', !!g.collapsed);
      chip.classList.toggle('untitled', !g.title);
      chip.title = `${g.title || 'Unnamed group'} — click to ${g.collapsed ? 'expand' : 'collapse'}, right-click for more`;
      const name = chip.querySelector('.gname');
      if (name && name.textContent !== g.title) name.textContent = g.title;
      groups.add(g.id);
      els.push(chip);
    }
    let el = tabEls.get(t.id);
    if (!el) { el = makeTabEl(t.id); tabEls.set(t.id, el); }
    els.push(el);
  });
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  for (const [gid, el] of chipEls) if (!groups.has(gid)) { el.remove(); chipEls.delete(gid); }
  els.forEach((el, i) => { if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null); });
  tabs.forEach((t) => {
    const el = tabEls.get(t.id);
    el.classList.toggle('active', t.id === activeId);
    el.classList.toggle('discarded', !!t.discarded);
    el.classList.toggle('pinned', !!t.pinned);
    el.classList.toggle('grouped', !!t.group);
    el.classList.toggle('folded', !!(t.group && t.group.collapsed));
    if (t.group) el.style.setProperty('--gc', t.group.hex); else el.style.removeProperty('--gc');
    el.title = (t.title || 'New tab') + (t.muted ? ' (muted)' : '');
    el.querySelector('.inc').classList.toggle('hidden', !t.incognito);
    el.querySelector('.mut').classList.toggle('hidden', !t.muted);
    const ttl = el.querySelector('.ttl');
    if (ttl.textContent !== (t.title || 'New tab')) ttl.textContent = t.title || 'New tab';
    const fav = el.querySelector('.fav');
    const favKey = t.loading ? 'loading' : (t.favicon || 'globe');
    if (fav.dataset.key !== favKey) {
      fav.dataset.key = favKey;
      fav.style.backgroundImage = '';
      if (t.loading) fav.innerHTML = '<div class="spin"></div>';
      else if (t.favicon) {
        fav.innerHTML = '';
        fav.style.backgroundImage = `url("${cssUrl(t.favicon)}")`;
        // A favicon that doesn't load shows the globe (a pinned tab is only its icon).
        const probe = new Image();
        probe.onerror = () => { if (fav.dataset.key === favKey) { fav.style.backgroundImage = ''; fav.innerHTML = globeSvg(); } };
        probe.src = t.favicon;
      } else fav.innerHTML = globeSvg();
    }
  });
  afterTabsRender();
}

// Too many tabs to fit: the strip scrolls sideways (mouse wheel, trackpad), the active tab is brought into view when it
// changes, and the ▾ button (only shown then) lists every tab, with a search box.
let shownActive = null;
function afterTabsRender() {
  const host = $('tabs');
  if (activeId !== shownActive) {
    shownActive = activeId;
    const el = tabEls.get(activeId);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('tablist').classList.toggle('hidden', host.scrollWidth <= host.clientWidth + 1);
}
$('tabs').addEventListener('wheel', (e) => {
  const host = $('tabs');
  if (host.scrollWidth <= host.clientWidth) return;
  host.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  e.preventDefault();
}, { passive: false });
new ResizeObserver(() => afterTabsRender()).observe($('tabs')); // the window was resized
$('tablist').onclick = () => togglePanel('tabsearch');
// Dragging a tab or a group toward either end of a scrolled strip scrolls it, to reach tabs that are out of sight.
const stripEdge = { x: 0, at: 0, timer: 0 };
function stripEdgeStop() { clearInterval(stripEdge.timer); stripEdge.timer = 0; }
$('tabs').addEventListener('dragover', (e) => {
  if (dragId == null && dragGroup == null) return;
  stripEdge.x = e.clientX; stripEdge.at = performance.now();
  if (stripEdge.timer) return;
  stripEdge.timer = setInterval(() => {
    if ((dragId == null && dragGroup == null) || performance.now() - stripEdge.at > 800) return stripEdgeStop();
    const host = $('tabs'); const r = host.getBoundingClientRect(); const zone = 48;
    const d = stripEdge.x < r.left + zone ? stripEdge.x - (r.left + zone) : stripEdge.x > r.right - zone ? stripEdge.x - (r.right - zone) : 0; // negative = left
    if (d) host.scrollLeft += Math.sign(d) * Math.max(2, Math.round(Math.abs(d) / 3));
  }, 16);
}, true); // capture: the tabs stop the event for themselves
for (const type of ['dragend', 'drop']) document.addEventListener(type, stripEdgeStop, true);
// A tab dropped on the empty part of the strip goes to the end, outside any group.
$('tabs').addEventListener('dragover', (e) => { if (dragId != null || dragGroup != null || fromOtherWindow(e)) e.preventDefault(); });
$('tabs').addEventListener('drop', (e) => {
  const remote = fromOtherWindow(e);
  if (!remote && dragId == null && dragGroup == null) return;
  e.preventDefault();
  if (remote === TAB_TYPE) call('tabs.moveHere', { id: Number(e.dataTransfer.getData(TAB_TYPE)), index: tabs.length, groupId: null });
  else if (remote === GROUP_TYPE) call('tabs.moveGroupHere', { id: e.dataTransfer.getData(GROUP_TYPE), index: tabs.length });
  else if (dragGroup != null) call('tabs.moveGroup', { id: dragGroup, index: groupDropIndex(dragGroup, null, true) });
  else call('tabs.move', { id: dragId, index: tabs.length - 1, groupId: null });
  clearDropMarks();
});

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
  $('star-btn').title = tab.bookmarked ? `Bookmarked in ${tab.bookmarkIn || 'your bookmarks'}. Click to edit or remove it (Ctrl+D)` : 'Bookmark this page (Ctrl+D)';
  $('reader-btn').classList.toggle('hidden', !(web && tab.readable));
  renderTabs();
}

// ---- bookmarks bar ----
let marks = { nodes: [], showBar: false };
function folderSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>'; }
const kidsOf = (parent) => marks.nodes.filter((n) => n.parent === parent);
let bmDragId = null; // the bookmark being dragged along the bar
function clearDrop() { for (const el of document.querySelectorAll('#bmbar .drop-before, #bmbar .drop-after, #bmbar .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into'); }
// Where a drop on a chip lands: before it, after it, or (on a folder's middle) inside it.
function dropZone(el, e, isFolder) {
  const r = el.getBoundingClientRect();
  const f = (e.clientX - r.left) / Math.max(1, r.width);
  if (isFolder && f > 0.25 && f < 0.75) return 'into';
  return f < 0.5 ? 'before' : 'after';
}
function moveOnBar(id, zone, target) {
  if (zone === 'into') return call('bookmarks.move', { id, parent: target.id, index: 1e6 });
  const order = kidsOf('bar').map((n) => n.id);
  let at = order.indexOf(target.id) + (zone === 'after' ? 1 : 0);
  const from = order.indexOf(id);
  if (from !== -1 && from < at) at--; // the node leaves its old place first
  return call('bookmarks.move', { id, parent: 'bar', index: at });
}
function barChip(n) {
  const el = document.createElement('div');
  el.className = 'bm';
  const isFolder = n.type === 'folder';
  const ico = document.createElement('div');
  ico.className = 'ico';
  if (isFolder) ico.innerHTML = folderSvg();
  else if (n.icon) ico.style.backgroundImage = `url("${cssUrl(n.icon)}")`;
  else ico.innerHTML = globeSvg();
  const t = document.createElement('span');
  t.textContent = n.title || n.url;
  el.append(ico, t);
  el.title = isFolder ? n.title : `${n.title}\n${n.url}`;
  // A click opens it, not the press: a press may be the start of a drag to rearrange the bar (opening the page or
  // a menu on the press got in the way of every drag). The middle button opens a tab.
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no auto-scroll cursor
  el.addEventListener('click', (e) => {
    if (isFolder) { const r = el.getBoundingClientRect(); call('bookmarks.listMenu', { parent: n.id, x: r.left, y: r.bottom }); return; }
    call('bookmarks.open', { id: n.id, how: e.ctrlKey ? 'tab' : 'here' });
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1 && !isFolder) { e.preventDefault(); call('bookmarks.open', { id: n.id, how: 'tab' }); } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); call('bookmarks.contextMenu', { id: n.id, x: e.clientX, y: e.clientY }); });
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { bmDragId = n.id; e.dataTransfer.setData('text/plain', String(n.id)); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { bmDragId = null; clearDrop(); });
  el.addEventListener('dragover', (e) => {
    if (bmDragId == null || bmDragId === n.id) return;
    e.preventDefault();
    clearDrop();
    el.classList.add('drop-' + dropZone(el, e, isFolder));
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  el.addEventListener('drop', (e) => {
    if (bmDragId == null || bmDragId === n.id) return;
    e.preventDefault();
    moveOnBar(bmDragId, dropZone(el, e, isFolder), n);
    bmDragId = null;
    clearDrop();
  });
  return el;
}
function renderBar() {
  const bar = $('bmbar');
  bar.classList.toggle('hidden', !marks.showBar);
  if (!marks.showBar) return;
  const host = $('bm-items');
  host.innerHTML = '';
  const chips = kidsOf('bar').map((n) => { const el = barChip(n); host.append(el); return { el, id: n.id }; });
  // Bookmarks that don't fit go into the » menu.
  const limit = host.getBoundingClientRect().right;
  const hidden = chips.filter((c) => c.el.getBoundingClientRect().right > limit + 0.5);
  for (const c of hidden) c.el.style.visibility = 'hidden';
  const more = $('bm-more');
  more.classList.toggle('hidden', !hidden.length);
  more.onmousedown = (e) => { if (e.button === 0) { const r = more.getBoundingClientRect(); call('bookmarks.listMenu', { ids: hidden.map((c) => c.id), x: r.left, y: r.bottom }); } };
  // "Other bookmarks": everything that isn't on the bar.
  const other = $('bm-other');
  other.classList.toggle('hidden', !kidsOf('other').length);
  other.onmousedown = (e) => { if (e.button === 0) { const r = other.getBoundingClientRect(); call('bookmarks.listMenu', { parent: 'other', x: Math.max(0, r.right - 220), y: r.bottom }); } };
}
// Dropping on empty space at the end of the bar puts the bookmark last; on "Other bookmarks", inside it.
$('bm-items').addEventListener('dragover', (e) => { if (bmDragId != null && e.target === $('bm-items')) e.preventDefault(); });
$('bm-items').addEventListener('drop', (e) => { if (bmDragId != null && e.target === $('bm-items')) { e.preventDefault(); call('bookmarks.move', { id: bmDragId, parent: 'bar', index: 1e6 }); bmDragId = null; clearDrop(); } });
$('bm-other').addEventListener('dragover', (e) => { if (bmDragId != null) { e.preventDefault(); clearDrop(); $('bm-other').classList.add('drop-into'); } });
$('bm-other').addEventListener('dragleave', () => $('bm-other').classList.remove('drop-into'));
$('bm-other').addEventListener('drop', (e) => { if (bmDragId != null) { e.preventDefault(); call('bookmarks.move', { id: bmDragId, parent: 'other', index: 1e6 }); bmDragId = null; clearDrop(); } });
// An update that changes nothing is skipped: redrawing the chips under the mouse would cancel a click or a drag in progress.
let marksKey = '';
api.on('bookmarks', (d) => { const key = JSON.stringify(d); if (key === marksKey) return; marksKey = key; marks = d; renderBar(); });
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
// Add-ons that aren't installed: a warning on the menu button (the menu lists them).
function showAddons(d) {
  const n = (d && d.missing || []).length;
  const up = d && d.update;
  $('menu-badge').classList.toggle('hidden', !n && !up);
  $('menu-badge').classList.toggle('new', !!up);
  $('menu-btn').title = ['Menu', up ? `NovaDM ${up.version} is available` : '', n ? `${d.missing.map((a) => a.name).join(', ')} not installed` : ''].filter(Boolean).join(' – ');
}
api.on('addons', showAddons);
// "Update": restarts into the downloaded version; the portable version opens the menu (Download…).
let updateReady = false;
function showUpdate(d) {
  const u = d && d.update;
  updateReady = !!(u && u.auto && u.phase === 'ready');
  $('update-pill').classList.toggle('hidden', !(updateReady || (u && !u.auto)));
  $('update-pill').title = u ? `NovaDM ${u.version} ${updateReady ? 'is ready: click to restart and update' : 'is available'}` : '';
}
api.on('addons', showUpdate);
call('addons.state').then(showUpdate).catch(() => {});
$('update-pill').onclick = () => { if (updateReady) call('update.install'); else togglePanel('menu'); };
call('addons.state').then(showAddons).catch(() => {});

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
// Tab to search: "youtube" + Tab, then what you type is searched on that site (site-search.js).
let site = null; // the site being searched
let siteHint = null; // the site the typed text names (Tab picks it)
function setSite(s) {
  site = s;
  $('site-chip').classList.toggle('hidden', !s);
  $('site-chip').textContent = s ? `Search ${s.name}` : '';
  urlEl.placeholder = s ? `Search ${s.name}` : 'Search or enter address';
  showTabHint(null);
}
function showTabHint(s) {
  siteHint = s;
  $('tab-hint').classList.toggle('hidden', !s);
  $('tab-hint').innerHTML = s ? `Press <kbd>Tab</kbd> to search ${s.name.replace(/[<&]/g, '')}` : '';
}
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
  setSite(null);
  $('omnibox').classList.remove('focus');
  const a = tabs.find((t) => t.id === activeId);
  if (a) urlEl.value = a.url || '';
  // Later than the overlay's mousedown, so a click on a suggestion still counts.
  setTimeout(hideSuggestions, 200);
});
urlEl.addEventListener('input', () => {
  typed = urlEl.value;
  if (site) return; // searching a site: no history suggestions
  requestSuggestions();
  const q = urlEl.value;
  call('omni.site', { q }).then((s) => { if (urlEl.value === q && !site) showTabHint(s); }).catch(() => {});
});
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !site && siteHint && urlEl.selectionStart === urlEl.value.length) {
    e.preventDefault();
    hideSuggestions();
    setSite(siteHint);
    urlEl.value = '';
    return;
  }
  if (e.key === 'Backspace' && site && !urlEl.value) { e.preventDefault(); setSite(null); return; }
  if (e.key === 'Enter' && site) {
    const q = urlEl.value.trim();
    if (q) { const url = site.url.replace('%s', encodeURIComponent(q)); if (e.altKey) call('tabs.new', { url }); else call('nav.go', { input: url }); }
    urlEl.blur();
    return;
  }
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
api.on('focus-address', (d) => {
  if (d && d.keep && document.activeElement === urlEl && document.hasFocus()) return; // keep what's already typed
  urlEl.focus();
  urlEl.select();
});

function cssUrl(u) { return String(u).replace(/["\\]/g, ''); }
function globeSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>'; }
function mutedSvg() { return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>'; }
function xSvg() { return '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'; }

call('tabs.list').then((d) => { tabs = d.tabs || []; activeId = d.activeId; renderTabs(); });
call('bookmarks.state').then((d) => { marks = d; renderBar(); });
