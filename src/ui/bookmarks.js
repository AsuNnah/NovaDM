'use strict';
// Bookmarks page (novadm://bookmarks, Ctrl+Shift+O): open, rename, move to a folder, delete,
// import / export, bookmarks bar on or off.
const bridge = window.novadmInternal;
const $ = (id) => document.getElementById(id);
let state = { items: [], showBar: false };
let editing = null;

const GLOBE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>';

async function refresh() {
  state = await bridge.call('bookmarks.state');
  const s = await bridge.getSettings();
  $('showBar').checked = s.showBookmarksBar !== false;
  render();
}

function render() {
  if (editing != null) return;
  const list = $('list');
  list.innerHTML = '';
  const q = $('q').value.trim().toLowerCase();
  const items = state.items.filter((b) => !q || (b.title + ' ' + b.url + ' ' + b.folder).toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = `<div class="card" style="margin-top:16px"><div class="empty">${q ? 'No bookmarks match your search.' : 'No bookmarks yet. Click the star in the address bar to add the page you\'re on.'}</div></div>`;
    return;
  }
  const groups = new Map([['', []]]);
  for (const b of items) { if (!groups.has(b.folder)) groups.set(b.folder, []); groups.get(b.folder).push(b); }
  for (const [folder, group] of groups) {
    if (!group.length) continue;
    const h = document.createElement('h2');
    h.textContent = folder || 'Bookmarks bar';
    const card = document.createElement('div');
    card.className = 'card';
    for (const b of group) card.append(row(b));
    list.append(h, card);
  }
}

function row(b) {
  const r = document.createElement('div');
  r.className = 'row';
  const ico = document.createElement('div');
  ico.className = 'ico';
  if (/^data:image\//.test(b.icon || '')) ico.style.backgroundImage = `url("${b.icon.replace(/["\\]/g, '')}")`; else ico.innerHTML = GLOBE;
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  ttl.textContent = b.title || b.url;
  ttl.addEventListener('mousedown', (e) => {
    if (e.button === 0) bridge.call('bookmarks.open', { id: b.id, how: e.ctrlKey ? 'tab' : 'here' });
    else if (e.button === 1) { e.preventDefault(); bridge.call('bookmarks.open', { id: b.id, how: 'tab' }); }
  });
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = b.url;
  const form = document.createElement('div');
  form.className = 'form';
  const fTitle = Object.assign(document.createElement('input'), { value: b.title, placeholder: 'Name' });
  const fUrl = Object.assign(document.createElement('input'), { value: b.url, placeholder: 'Address', spellcheck: false });
  const fFolder = Object.assign(document.createElement('input'), { value: b.folder, placeholder: 'Folder (empty: bookmarks bar)' });
  form.append(fTitle, fUrl, fFolder);
  const acts = document.createElement('div');
  acts.className = 'acts';
  const edit = Object.assign(document.createElement('button'), { textContent: 'Edit' });
  const del = Object.assign(document.createElement('button'), { textContent: 'Delete', className: 'danger' });
  edit.onclick = async () => {
    if (editing === b.id) {
      await bridge.call('bookmarks.update', { id: b.id, title: fTitle.value.trim(), url: fUrl.value.trim(), folder: fFolder.value.trim() });
      editing = null;
      refresh();
      return;
    }
    editing = b.id;
    r.classList.add('edit');
    edit.textContent = 'Save';
    fTitle.focus();
  };
  for (const f of [fTitle, fUrl, fFolder]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit.click(); if (e.key === 'Escape') { editing = null; render(); } });
  del.onclick = async () => { await bridge.call('bookmarks.remove', { id: b.id }); refresh(); };
  acts.append(edit, del);
  r.append(ico, ttl, url, form, acts);
  return r;
}

$('q').addEventListener('input', render);
$('showBar').onchange = () => bridge.call('bookmarks.setBar', { show: $('showBar').checked });
$('import').onclick = async () => {
  const r = await bridge.call('bookmarks.import');
  if (r && r.ok) alert(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already here or not web pages)` : ''}.`);
  else if (r && r.error) alert('Could not import: ' + r.error);
  refresh();
};
$('export').onclick = () => bridge.call('bookmarks.export');
bridge.on('bookmarks', (d) => { state = d; render(); });
refresh();
