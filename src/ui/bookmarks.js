'use strict';
// Bookmarks page (novadm://bookmarks, Ctrl+Shift+O): the bookmarks as a tree with two parts (Bookmarks bar,
// Other bookmarks); open, rename, new folder, drag to move, delete; import from another browser or a file,
// export; bookmarks bar on or off.
const bridge = window.novadmInternal;
const $ = (id) => document.getElementById(id);
let state = { nodes: [], showBar: false };
let editing = null;
let pendingEdit = null; // a new folder: its name is typed as soon as it shows
let drag = null; // id of the node being dragged
const folded = new Set(); // folders closed in this page
const sel = new Set(); // ticked nodes (check boxes)
let lastTick = null; // the last box ticked, for Shift+click ranges
let order = []; // node ids in the order they are shown

const GLOBE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';

const kids = (parent) => state.nodes.filter((n) => n.parent === parent);
const byId = (id) => state.nodes.find((n) => n.id === id);
const count = (id) => kids(id).reduce((c, n) => c + (n.type === 'folder' ? count(n.id) : 1), 0);
const pathOf = (n) => { const out = []; for (let p = byId(n.parent); p; p = byId(p.parent)) out.unshift(p.title); return out.join(' › '); };

async function refresh() {
  state = await bridge.call('bookmarks.state');
  const s = await bridge.getSettings();
  $('showBar').checked = s.showBookmarksBar !== false;
  render();
}

function say(text, bad) { const m = $('msg'); m.textContent = text; m.className = 'msg' + (bad ? ' bad' : ''); m.hidden = !text; }

const below = (id) => kids(id).flatMap((n) => [n.id, ...(n.type === 'folder' ? below(n.id) : [])]); // everything inside a folder
const search = () => $('q').value.trim().toLowerCase();
const hits = () => state.nodes.filter((n) => n.type === 'url' && (n.title + ' ' + n.url).toLowerCase().includes(search())).map((n) => n.id);
// Select all / none / invert act on what the search shows, or on everything.
const scope = () => (search() ? hits() : state.nodes.map((n) => n.id));

function tick(n, on, shift) {
  let ids = [n.id, ...(n.type === 'folder' ? below(n.id) : [])];
  const a = order.indexOf(lastTick);
  const b = order.indexOf(n.id);
  if (shift && a !== -1 && b !== -1) ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  for (const id of ids) { if (on) sel.add(id); else sel.delete(id); }
  lastTick = n.id;
  keepScroll(render);
}
function keepScroll(fn) { const y = window.scrollY; fn(); window.scrollTo(0, y); }

// Dragging near the top or bottom edge scrolls the page, so a bookmark can be dropped on a place that is out of
// sight (the browser's own scrolling during a drag did not happen here). Stops when the drag ends or leaves the window.
const edge = { y: 0, at: 0, timer: 0 };
function edgeStop() { clearInterval(edge.timer); edge.timer = 0; }
document.addEventListener('dragover', (e) => {
  if (drag == null) return;
  edge.y = e.clientY; edge.at = performance.now();
  if (edge.timer) return;
  edge.timer = setInterval(() => {
    if (drag == null || performance.now() - edge.at > 800) return edgeStop();
    const zone = 80; const h = window.innerHeight;
    const d = edge.y < zone ? edge.y - zone : edge.y > h - zone ? edge.y - (h - zone) : 0; // pixels into the edge zone; negative = up
    if (d) window.scrollBy(0, Math.sign(d) * Math.max(2, Math.round(Math.abs(d) / 3)));
  }, 16);
}, true);
for (const type of ['dragend', 'drop']) document.addEventListener(type, edgeStop, true);

// What the ticked nodes stand for: bookmarks and folders, folders counting what is inside.
function chosen() {
  const all = new Set();
  for (const id of sel) if (byId(id)) { all.add(id); if (byId(id).type === 'folder') for (const x of below(id)) all.add(x); }
  const nodes = [...all].map(byId);
  return { ids: [...sel].filter(byId), urls: nodes.filter((n) => n.type === 'url').length, folders: nodes.filter((n) => n.type === 'folder').length };
}

function folderOptions() {
  const res = [];
  const walk = (parent, depth) => { for (const f of kids(parent).filter((n) => n.type === 'folder')) { res.push([f.id, '\u2003'.repeat(depth) + f.title]); walk(f.id, depth + 1); } };
  for (const [root, label] of [['bar', 'Bookmarks bar'], ['other', 'Other bookmarks']]) { res.push([root, label]); walk(root, 1); }
  return res;
}

function updateBar() {
  for (const id of [...sel]) if (!byId(id)) sel.delete(id);
  const n = sel.size;
  $('selcount').textContent = n ? `${n} selected` : 'Nothing selected';
  for (const b of document.querySelectorAll('#selbar .need')) b.disabled = !n;
  const pick = $('moveTo');
  const keep = pick.value;
  pick.innerHTML = '';
  for (const [v, label] of folderOptions()) pick.append(Object.assign(document.createElement('option'), { value: String(v), textContent: label }));
  if ([...pick.options].some((o) => o.value === keep)) pick.value = keep;
}

async function bulk(action) {
  const c = chosen();
  if (!c.ids.length) return;
  const what = `${c.folders ? `${c.folders} folder${c.folders === 1 ? '' : 's'} and ` : ''}${c.urls} bookmark${c.urls === 1 ? '' : 's'}`;
  if (action === 'delete' && !confirm(`Delete ${what}?`)) return;
  if ((action === 'open' || action === 'private') && c.urls > 10 && !confirm(`Open ${c.urls} ${action === 'open' ? 'tabs' : 'tabs in a private window'}?`)) return;
  const parent = /^\d+$/.test($('moveTo').value) ? Number($('moveTo').value) : $('moveTo').value;
  const r = await bridge.call('bookmarks.bulk', { action, ids: c.ids, parent });
  if (action === 'delete') { say(`Deleted ${what}.`); sel.clear(); }
  else if (action === 'move') { say(r.count ? `Moved ${r.count} item${r.count === 1 ? '' : 's'}.` : 'Nothing was moved (a folder cannot go inside itself).', !r.count); if (r.count) sel.clear(); }
  else say(`Opened ${r.count} bookmark${r.count === 1 ? '' : 's'}.`);
  await refresh();
}

function render() {
  if (editing != null) return;
  const list = $('list');
  list.innerHTML = '';
  order = [];
  const q = search();
  if (q) {
    const found = hits().map(byId);
    const card = document.createElement('div');
    card.className = 'card';
    if (!found.length) card.innerHTML = '<div class="empty">No bookmarks match your search.</div>';
    for (const n of found) card.append(row(n, 0, true));
    list.append(card);
    updateBar();
    return;
  }
  for (const [root, title] of [['bar', 'Bookmarks bar'], ['other', 'Other bookmarks']]) {
    const h = document.createElement('h2');
    h.textContent = title;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.root = root;
    const fill = (parent, depth) => {
      for (const n of kids(parent)) {
        card.append(row(n, depth));
        if (n.type === 'folder' && !folded.has(n.id)) fill(n.id, depth + 1);
      }
    };
    fill(root, 0);
    if (!card.children.length) card.innerHTML = `<div class="empty small">${root === 'bar' ? 'Nothing on the bar yet. Click the star in the address bar (Ctrl+D) to add the page you\'re on.' : 'Nothing here. Drag a bookmark onto this box to move it here.'}</div>`;
    // Dropping on the box itself (not on a row) puts the node last.
    card.addEventListener('dragover', (e) => { if (drag != null && e.target === card) e.preventDefault(); });
    card.addEventListener('drop', (e) => { if (drag != null && e.target === card) { e.preventDefault(); bridge.call('bookmarks.move', { id: drag, parent: root, index: 1e6 }).then(refresh); drag = null; } });
    list.append(h, card);
  }
  updateBar();
}

// before / after a row, or inside a folder (its middle).
function zone(el, e, isFolder) {
  const r = el.getBoundingClientRect();
  const f = (e.clientY - r.top) / Math.max(1, r.height);
  if (isFolder && f > 0.3 && f < 0.7) return 'into';
  return f < 0.5 ? 'before' : 'after';
}
function dropOn(n, z) {
  if (z === 'into') return { parent: n.id, index: 1e6 };
  const sibs = kids(n.parent).map((s) => s.id);
  let at = sibs.indexOf(n.id) + (z === 'after' ? 1 : 0);
  const from = sibs.indexOf(drag);
  if (from !== -1 && from < at) at--; // the node leaves its old place first
  return { parent: n.parent, index: at };
}

function row(n, depth, flat) {
  const isFolder = n.type === 'folder';
  order.push(n.id);
  const r = document.createElement('div');
  r.className = 'row' + (sel.has(n.id) ? ' picked' : '');
  r.style.paddingLeft = (14 + depth * 22) + 'px';
  const cb = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'cb', checked: sel.has(n.id), title: isFolder ? 'Select this folder and what is in it' : 'Select' });
  cb.onclick = (e) => tick(n, cb.checked, e.shiftKey);
  const caret = document.createElement('span');
  caret.className = 'caret';
  if (isFolder) {
    caret.textContent = folded.has(n.id) ? '▸' : '▾';
    caret.onclick = () => { if (folded.has(n.id)) folded.delete(n.id); else folded.add(n.id); render(); };
  }
  const ico = document.createElement('div');
  ico.className = 'ico';
  if (isFolder) ico.innerHTML = FOLDER;
  else if (/^data:image\//.test(n.icon || '')) ico.style.backgroundImage = `url("${n.icon.replace(/["\\]/g, '')}")`;
  else ico.innerHTML = GLOBE;
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  ttl.textContent = n.title || n.url;
  if (isFolder) {
    ttl.onclick = () => caret.onclick();
    ttl.title = `${count(n.id)} bookmark${count(n.id) === 1 ? '' : 's'}`;
  } else {
    ttl.addEventListener('mousedown', (e) => {
      if (e.button === 0) bridge.call('bookmarks.open', { id: n.id, how: e.ctrlKey ? 'tab' : 'here' });
      else if (e.button === 1) { e.preventDefault(); bridge.call('bookmarks.open', { id: n.id, how: 'tab' }); }
    });
  }
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = isFolder ? `${count(n.id)} inside` : (flat ? pathOf(n) || n.url : n.url);
  if (flat && !isFolder) url.title = n.url;
  const form = document.createElement('div');
  form.className = 'form';
  const fTitle = Object.assign(document.createElement('input'), { value: n.title, placeholder: 'Name' });
  const fUrl = Object.assign(document.createElement('input'), { value: n.url, placeholder: 'Address', spellcheck: false });
  form.append(fTitle);
  if (!isFolder) form.append(fUrl);
  const acts = document.createElement('div');
  acts.className = 'acts';
  const edit = Object.assign(document.createElement('button'), { textContent: 'Edit' });
  const del = Object.assign(document.createElement('button'), { textContent: 'Delete', className: 'danger' });
  const finish = async () => {
    await bridge.call('bookmarks.update', { id: n.id, title: fTitle.value.trim(), ...(isFolder ? {} : { url: fUrl.value.trim() }) });
    editing = null;
    refresh();
  };
  const begin = () => { editing = n.id; r.classList.add('edit'); edit.textContent = 'Save'; fTitle.focus(); fTitle.select(); };
  edit.onclick = () => { if (editing === n.id) finish(); else begin(); };
  for (const f of [fTitle, fUrl]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') { editing = null; render(); } });
  del.onclick = async () => {
    if (isFolder && count(n.id) && !confirm(`Delete the folder "${n.title}" and the ${count(n.id)} bookmark${count(n.id) === 1 ? '' : 's'} in it?`)) return;
    await bridge.call('bookmarks.remove', { id: n.id });
    refresh();
  };
  acts.append(edit, del);
  r.append(cb, caret, ico, ttl, url, form, acts);
  if (pendingEdit === n.id) { pendingEdit = null; setTimeout(begin, 0); }
  if (!flat) {
    r.draggable = true;
    r.addEventListener('dragstart', (e) => { drag = n.id; e.dataTransfer.setData('text/plain', String(n.id)); e.dataTransfer.effectAllowed = 'move'; });
    r.addEventListener('dragend', () => { drag = null; for (const x of document.querySelectorAll('.drop-before,.drop-after,.drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into'); });
    r.addEventListener('dragover', (e) => {
      if (drag == null || drag === n.id) return;
      e.preventDefault();
      for (const x of document.querySelectorAll('.drop-before,.drop-after,.drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into');
      r.classList.add('drop-' + zone(r, e, isFolder));
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-before', 'drop-after', 'drop-into'));
    r.addEventListener('drop', async (e) => {
      if (drag == null || drag === n.id) return;
      e.preventDefault();
      const to = dropOn(n, zone(r, e, isFolder));
      const id = drag;
      drag = null;
      const res = await bridge.call('bookmarks.move', { id, ...to });
      if (res && !res.ok) say('That folder cannot go inside itself.', true);
      refresh();
    });
  }
  return r;
}

$('q').addEventListener('input', render);
$('selAll').onclick = () => { for (const id of scope()) sel.add(id); keepScroll(render); };
$('selNone').onclick = () => { for (const id of scope()) sel.delete(id); keepScroll(render); };
$('selInvert').onclick = () => { for (const id of scope()) { if (sel.has(id)) sel.delete(id); else sel.add(id); } keepScroll(render); };
$('bulkMove').onclick = () => bulk('move');
$('bulkOpen').onclick = () => bulk('open');
$('bulkPrivate').onclick = () => bulk('private');
$('bulkDelete').onclick = () => bulk('delete');
$('showBar').onchange = () => bridge.call('bookmarks.setBar', { show: $('showBar').checked });
$('newFolder').onclick = async () => {
  const r = await bridge.call('bookmarks.newFolder', { title: 'New folder', parent: 'bar' });
  await refresh();
  if (r && r.id != null) { pendingEdit = r.id; render(); }
};
const done = (r) => {
  if (r && r.ok) say(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already here or not web pages)` : ''}.`);
  else if (r && r.error) say('Could not import: ' + r.error, true);
  $('imp').hidden = true;
  refresh();
};
$('import').onclick = async () => {
  const box = $('imp');
  if (!box.hidden) { box.hidden = true; return; }
  const { list } = await bridge.call('bookmarks.browsers');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'imp-title';
  title.textContent = list.length ? 'Import from a browser on this PC' : 'No other browser with bookmarks was found on this PC.';
  box.append(title);
  list.forEach((b, i) => {
    const btn = Object.assign(document.createElement('button'), { textContent: `${b.browser} — ${b.profile}` });
    btn.onclick = async () => done(await bridge.call('bookmarks.importFrom', { index: i }));
    box.append(btn);
  });
  const file = Object.assign(document.createElement('button'), { textContent: 'From a file…' });
  file.onclick = async () => done(await bridge.call('bookmarks.import'));
  box.append(file);
  box.hidden = false;
};
$('export').onclick = () => bridge.call('bookmarks.export');
bridge.on('bookmarks', (d) => { state = d; render(); });
refresh();
