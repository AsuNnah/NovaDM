'use strict';
// History page (novadm://history, Ctrl+H): search, open, delete, clear browsing data.
const bridge = window.novadmInternal;
const $ = (id) => document.getElementById(id);
const PAGE = 150;
let items = [];
let done = false;
const selected = new Set();

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return diff === 0 ? `Today - ${date}` : diff === 1 ? `Yesterday - ${date}` : date;
}

async function load(reset) {
  if (reset) { items = []; done = false; }
  const before = items.length ? items[items.length - 1].t : 0;
  const r = await bridge.call('history.search', { q: $('q').value, limit: PAGE, before: before || undefined });
  items = items.concat(r.items || []);
  done = (r.items || []).length < PAGE;
  render();
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<div class="card"><div class="empty">${$('q').value ? 'No pages match your search.' : 'Pages you visit show up here. Private tabs are never recorded.'}</div></div>`;
    $('moreBox').hidden = true;
    renderBulk();
    return;
  }
  let card = null;
  let day = '';
  for (const v of items) {
    const label = dayLabel(v.t);
    if (label !== day) {
      day = label;
      card = document.createElement('div');
      card.className = 'card';
      const h = document.createElement('div');
      h.className = 'day';
      h.textContent = label;
      card.append(h);
      list.append(card);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(v.id);
    cb.onchange = () => { if (cb.checked) selected.add(v.id); else selected.delete(v.id); renderBulk(); };
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(v.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = v.title || v.url;
    ttl.title = v.url;
    ttl.addEventListener('mousedown', (e) => {
      if (e.button === 0) bridge.call('history.open', { url: v.url, newTab: e.ctrlKey });
      else if (e.button === 1) { e.preventDefault(); bridge.call('history.open', { url: v.url, newTab: true }); }
    });
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(v.url);
    const x = document.createElement('button');
    x.className = 'x';
    x.title = 'Remove from history';
    x.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.onclick = async () => { await bridge.call('history.remove', { ids: [v.id] }); items = items.filter((i) => i.id !== v.id); render(); };
    row.append(cb, time, ttl, host, x);
    card.append(row);
  }
  $('moreBox').hidden = done;
  renderBulk();
}

function renderBulk() {
  $('bulk').hidden = !selected.size;
  $('selCount').textContent = `${selected.size} selected`;
}

let qTimer = null;
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => load(true), 200); });
$('more').onclick = () => load(false);
$('selNone').onclick = () => { selected.clear(); render(); };
$('selDelete').onclick = async () => {
  await bridge.call('history.remove', { ids: [...selected] });
  items = items.filter((i) => !selected.has(i.id));
  selected.clear();
  render();
};
$('clearBtn').onclick = () => { $('clearBox').hidden = false; };
$('clearCancel').onclick = () => { $('clearBox').hidden = true; };
$('clearGo').onclick = async () => {
  $('clearGo').disabled = true;
  await bridge.call('history.clear', { range: $('range').value, history: $('cHistory').checked, cookies: $('cCookies').checked, cache: $('cCache').checked });
  $('clearGo').disabled = false;
  $('clearBox').hidden = true;
  load(true);
};
// Visits from other tabs while this page is open.
bridge.on('history', () => { if (!$('q').value && !selected.size && window.scrollY < 50) load(true); });
if (new URLSearchParams(location.search).get('clear')) $('clearBox').hidden = false;
load(true);
