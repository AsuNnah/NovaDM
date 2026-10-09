'use strict';
const api = window.novadmInternal;
const $ = (id) => document.getElementById(id);

let items = [];
let summary = {};
const state = { tab: 'all', cat: '', q: '' };
const selected = new Set();
const rows = new Map(); // id -> row element (updated in place)

const TABS = [
  ['all', 'All', () => true],
  ['active', 'Downloading', (d) => ['downloading', 'connecting', 'queued'].includes(d.state)],
  ['done', 'Finished', (d) => d.state === 'done'],
  ['unfinished', 'Unfinished', (d) => ['paused', 'error', 'scheduled'].includes(d.state)],
];
const CATS = { video: 'Video', music: 'Music', images: 'Images', documents: 'Documents', archives: 'Archives', programs: 'Programs', other: 'Other' };

// ---- formatting ----
function fmtSize(b) {
  if (!(b >= 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + u[i];
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${x}s`;
  return `${x}s`;
}
function fmtClock(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return (h ? h + 'h ' : '') + m + 'm ' + String(s).padStart(2, '0') + 's';
}
function fmtDate(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const SCAN_TEXT = {
  scanning: 'Scanning with Microsoft Defender…',
  clean: 'No threats found',
  threat: '<span class="err">Threat found by Microsoft Defender</span>',
  error: '',
  unavailable: '',
};
let queueInfo = { queues: [], afterAllDone: 'nothing' };
const queueName = (id) => { const q = queueInfo.queues.find((x) => x.id === id); return q ? q.name : 'Main'; };

const EXTRACT_TEXT = (d) => (d.extract === 'extracting' ? 'Unpacking…' : d.extract === 'done' ? `Unpacked to “${esc(String(d.extractedTo || '').split(/[\\/]/).pop())}”` : d.extract === 'error' ? '<span class="err">Could not unpack</span>' : '');
const ARCHIVE = /\.(zip|7z|rar|tar|tgz|tbz2|txz|tar\.gz|tar\.bz2|tar\.xz|tar\.zst|cab|iso)$/i;

const VERIFY_TEXT = {
  ok: 'Checksum matches',
  mismatch: '<span class="err">Checksum does NOT match</span>',
  checking: 'Checking checksum…',
  error: '<span class="err">Checksum could not be checked</span>',
};

function statusText(d) {
  const pct = Math.floor(d.percent || 0);
  const parts = d.segments ? `Part ${d.doneSegments || 0} of ${d.segments}` : '';
  const sizeTxt = d.size > 0 ? `${fmtSize(d.received)} of ${d.sizeIsEstimate ? '~' : ''}${fmtSize(d.size)}` : fmtSize(d.received);
  if (d.kind === 'torrent') {
    if (d.phase === 'metadata' && d.state !== 'error') return 'Getting the torrent’s details from other computers…';
    if (d.phase === 'choosing' && d.state !== 'error') return 'Waiting for you to choose the files';
    if (d.state === 'done' && d.seeding) return [fmtSize(d.size), `Seeding ↑ ${fmtSize(d.uploadSpeed || 0)}/s`, `ratio ${(d.ratio || 0).toFixed(2)}`].join(' · ');
    if (d.state === 'downloading' && d.connections) {
      const left = d.speed > 0 && d.size > 0 ? fmtDur(((d.size - d.received) / d.speed) * 1000) + ' left' : '';
      return [Math.floor(d.percent || 0) + '%', `${fmtSize(d.received)} of ${fmtSize(d.size)}`, d.speed > 0 ? fmtSize(d.speed) + '/s' : '', left, `${d.connections} peers`].filter(Boolean).join(' · ');
    }
  }
  if (d.kind === 'convert' && d.state === 'downloading') return `Converting “${esc(d.from)}”${d.percent > 0 ? ' · ' + Math.floor(d.percent) + '%' : '…'}`;
  if (d.joining && d.state === 'downloading') return 'Joining picture and sound with FFmpeg…';
  if (d.recording) return `<span class="rec">● Recording</span> · ${fmtClock(d.recordedSeconds || 0)} · ${fmtSize(d.received)}${d.speed > 0 ? ' · ' + fmtSize(d.speed) + '/s' : ''}`;
  if (d.live && d.state === 'done') return [`Recorded ${fmtClock(d.recordedSeconds || 0)}`, fmtSize(d.size), 'Finished ' + fmtDate(d.completedAt)].join(' · ');
  switch (d.state) {
    case 'downloading': {
      const left = d.speed > 0 && d.size > 0 ? fmtDur(((d.size - d.received) / d.speed) * 1000) + ' left' : '';
      return [pct + '%', sizeTxt, d.speed > 0 ? fmtSize(d.speed) + '/s' : '', left, parts].filter(Boolean).join(' · ');
    }
    case 'connecting': return ['Connecting…', parts].filter(Boolean).join(' · ');
    case 'queued': return ['Queued', d.received > 0 ? `${pct}% · ${sizeTxt}` : '', parts].filter(Boolean).join(' · ');
    case 'paused': return ['Paused', `${pct}%`, sizeTxt, parts].filter(Boolean).join(' · ');
    case 'error': return `<span class="err">Failed: ${esc(d.error || 'unknown error')}</span>` + (parts ? ' · ' + parts : '');
    case 'done': return [fmtSize(d.size), 'Finished ' + fmtDate(d.completedAt), VERIFY_TEXT[d.verify] || '', SCAN_TEXT[d.scan] || '', EXTRACT_TEXT(d)].filter(Boolean).join(' · ');
    case 'scheduled': {
      const q = queueInfo.queues.find((x) => x.id === d.queue);
      const when = q && q.next ? 'starts ' + fmtDate(q.next) : 'waits for its schedule';
      return [`Scheduled (${esc(queueName(d.queue))}) · ${when}`, d.received > 0 ? `${pct}% · ${sizeTxt}` : ''].filter(Boolean).join(' · ');
    }
    default: return d.state;
  }
}

// ---- icons ----
const SVG = {
  video: '<path d="M4 5h16v14H4z"/><path d="M10 9l5 3-5 3z"/>',
  music: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 18V5l12-2v13"/>',
  images: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  archives: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
  programs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  documents: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
  other: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  retry: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
};
const svg = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[name] || SVG.other}</svg>`;

// ---- list ----
function visible() {
  const tabFn = TABS.find((t) => t[0] === state.tab)[2];
  const q = state.q.toLowerCase();
  return items.filter((d) => tabFn(d) && (!state.cat || d.category === state.cat) && (!q || d.name.toLowerCase().includes(q)));
}

function renderFilters() {
  const tabsEl = $('tabs');
  tabsEl.innerHTML = '';
  for (const [key, label, fn] of TABS) {
    const b = document.createElement('button');
    b.className = 'tab' + (state.tab === key ? ' on' : '');
    b.textContent = `${label} (${items.filter(fn).length})`;
    b.onclick = () => { state.tab = key; renderAll(); };
    tabsEl.appendChild(b);
  }
  const chips = $('chips');
  chips.innerHTML = '';
  const present = Object.keys(CATS).filter((c) => items.some((d) => d.category === c));
  chips.hidden = present.length < 2;
  for (const c of ['', ...present]) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.cat === c ? ' on' : '');
    b.textContent = c ? CATS[c] : 'All types';
    b.onclick = () => { state.cat = c; renderAll(); };
    chips.appendChild(b);
  }
}

function makeRow(d) {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `<input type="checkbox"><div class="ico">${svg(d.category in SVG ? d.category : 'other', 20)}<span class="dot"></span></div>
    <div class="main"><div class="name"></div><div class="status"></div><div class="bar"><i></i></div></div>
    <div class="acts"><button class="icon act" title=""></button><button class="icon more" title="More">${svg('more')}</button></div>`;
  const cb = el.querySelector('input');
  cb.onchange = () => { if (cb.checked) selected.add(d.id); else selected.delete(d.id); updateBulk(); el.classList.toggle('sel', cb.checked); };
  el.querySelector('.name').onclick = () => { const cur = items.find((x) => x.id === d.id); if (cur && cur.state === 'done') api.call('downloads.openFile', { id: d.id }); };
  el.querySelector('.act').onclick = () => primaryAction(items.find((x) => x.id === d.id));
  el.querySelector('.more').onclick = (e) => { e.stopPropagation(); openMenu(e.currentTarget, items.find((x) => x.id === d.id)); };
  el.ondblclick = (e) => { if (e.target.closest('button,input')) return; const cur = items.find((x) => x.id === d.id); if (cur && cur.state === 'done') api.call('downloads.openFile', { id: d.id }); };
  return el;
}

function updateRow(el, d) {
  const name = el.querySelector('.name');
  if (name.textContent !== d.name) { name.textContent = d.name; name.title = d.savePath; }
  name.classList.toggle('done', d.state === 'done');
  el.querySelector('.status').innerHTML = statusText(d);
  el.querySelector('.dot').className = 'dot ' + d.state;
  const bar = el.querySelector('.bar');
  bar.hidden = d.state === 'done';
  bar.className = 'bar ' + (d.state === 'paused' || d.state === 'queued' ? 'paused' : d.state === 'error' ? 'error' : '');
  bar.firstElementChild.style.width = Math.min(100, d.percent || 0) + '%';
  const act = el.querySelector('.act');
  const kind = d.recording ? 'stop' : ['downloading', 'connecting'].includes(d.state) ? 'pause' : d.state === 'done' ? 'folder' : d.state === 'error' ? 'retry' : 'play';
  if (act.dataset.kind !== kind) {
    act.dataset.kind = kind;
    act.innerHTML = svg(kind);
    act.title = { pause: 'Pause', folder: 'Show in folder', retry: 'Retry', play: 'Resume', stop: 'Stop recording' }[kind];
  }
  const cb = el.querySelector('input');
  cb.checked = selected.has(d.id);
  el.classList.toggle('sel', cb.checked);
}

function primaryAction(d) {
  if (!d) return;
  if (d.state === 'error' && d.errorCode === 'LINK_EXPIRED') return showRefresh(d);
  if (d.recording) return api.call('downloads.stopRecording', { id: d.id });
  if (['downloading', 'connecting'].includes(d.state)) api.call('downloads.pause', { id: d.id });
  else if (d.state === 'done') api.call('downloads.showInFolder', { id: d.id });
  else api.call('downloads.resume', { id: d.id });
}

function renderList() {
  const list = $('list');
  const vis = visible();
  const ids = new Set(vis.map((d) => d.id));
  for (const [id, el] of rows) if (!ids.has(id)) { el.remove(); rows.delete(id); }
  if (!vis.length) {
    list.innerHTML = items.length
      ? '<div class="empty"><b>Nothing here</b>No downloads match these filters.</div>'
      : '<div class="empty"><b>No downloads yet</b>Videos you download from the media panel, files from links, and content you grab from pages show up here.</div>';
    rows.clear();
    return;
  }
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  vis.forEach((d, i) => {
    let el = rows.get(d.id);
    if (!el) { el = makeRow(d); rows.set(d.id, el); }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    updateRow(el, d);
  });
}

function renderSummary() {
  const active = items.filter((d) => ['downloading', 'connecting'].includes(d.state));
  const speed = active.reduce((s, d) => s + (d.speed || 0), 0);
  $('summary').textContent = active.length ? `${active.length} downloading · ${fmtSize(speed)}/s` : `${items.length} item${items.length === 1 ? '' : 's'}`;
}

function updateBulk() {
  for (const id of [...selected]) if (!items.some((d) => d.id === id)) selected.delete(id);
  $('bulk').hidden = selected.size === 0;
  $('bulkCount').textContent = `${selected.size} selected`;
}

function renderAll() { renderFilters(); renderList(); renderSummary(); updateBulk(); }

// ---- menus and dialogs ----
function closeLayer() { $('layer').innerHTML = ''; }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) { const m = document.querySelector('.menu'); if (m) m.remove(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLayer(); });

function openMenu(anchor, d) {
  if (!d) return;
  closeLayer();
  const m = document.createElement('div');
  m.className = 'menu';
  const add = (label, fn, cls) => { const it = document.createElement('div'); it.textContent = label; if (cls) it.className = cls; it.onclick = () => { m.remove(); fn(); }; m.appendChild(it); };
  const hr = () => m.appendChild(document.createElement('hr'));
  if (d.state === 'done') { add('Open', () => api.call('downloads.openFile', { id: d.id })); }
  add('Show in folder', () => api.call('downloads.showInFolder', { id: d.id }));
  add('Properties', () => showProperties(d.id));
  hr();
  add('Copy download link', () => api.call('downloads.copyLink', { id: d.id }));
  if (d.pageUrl) { add('Copy page link', () => api.call('downloads.copyLink', { id: d.id, which: 'page' })); add('Open download page', () => api.call('downloads.openPage', { id: d.id })); }
  if (d.state !== 'done' && !d.native && !['convert', 'torrent'].includes(d.kind)) add('Refresh link…', () => showRefresh(d));
  if (d.seeding) add('Stop seeding', () => api.call('downloads.stopSeeding', { id: d.id }));
  if (d.state === 'done' && ARCHIVE.test(d.name)) add('Extract here', () => api.call('downloads.extract', { id: d.id }));
  if (d.state === 'done' && ['video', 'music'].includes(d.category)) {
    hr();
    const conv = (label, action) => add(label, async () => {
      const r = await api.call('downloads.convert', { id: d.id, action });
      if (r && !r.ok) showNotice(r.code === 'NEEDS_FFMPEG' ? 'FFmpeg is needed for this. Install it in Settings → Add-ons.' : r.error);
    });
    if (d.category === 'video') conv('Save sound only (.m4a)', 'audio');
    conv('Convert sound to MP3', 'mp3');
    if (d.category === 'video') conv('Repair video', 'repair');
  }
  if (d.state !== 'done' && queueInfo.queues.length > 1) {
    for (const q of queueInfo.queues) if (q.id !== (d.queue || 'main')) add(`Move to queue “${q.name}”`, () => api.call('downloads.setQueue', { id: d.id, queue: q.id }));
  }
  add('Download again', () => api.call('downloads.redownload', { id: d.id }));
  hr();
  if (d.state === 'done') add('Remove from list', () => api.call('downloads.remove', { id: d.id }));
  add(d.state === 'done' ? 'Delete file' : 'Cancel and delete', () => confirmDelete([d]), 'red');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4) + 'px';
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
}

function modal(html) {
  closeLayer();
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="dialog">${html}</div>`;
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeLayer(); });
  $('layer').appendChild(wrap);
  return wrap;
}

// ---- queues and schedules ----
async function loadQueues() {
  try { queueInfo = await api.call('downloads.queues'); } catch {}
  const sel = $('afterAllDone');
  if (sel && document.activeElement !== sel) sel.value = queueInfo.afterAllDone || 'nothing';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function showQueues() {
  const draft = JSON.parse(JSON.stringify(queueInfo.queues));
  const w = modal(`<h2>Queues and schedules</h2>
    <p>Downloads in a queue with a schedule start when its time comes and pause when it ends. Without an end time the queue runs until it's done.</p>
    <div class="qlist" id="qlist"></div>
    <div class="foot"><button id="qAdd">New queue</button><span style="flex:1"></span><button id="qCancel">Cancel</button><button class="pri" id="qSave">Save</button></div>`);
  const list = w.querySelector('#qlist');
  const render = () => {
    list.innerHTML = '';
    draft.forEach((q, i) => {
      const s = q.schedule || { enabled: false, start: '01:00', stop: '06:00', days: [] };
      const item = document.createElement('div');
      item.className = 'qitem';
      item.innerHTML = `
        <div class="k">Name</div><div><input type="text" data-f="name" value="${esc(q.name)}" ${q.id === 'main' ? 'disabled' : ''}></div>
        <div class="k">At once</div><div><input type="number" data-f="maxActive" min="0" max="10" value="${q.maxActive || 0}"> <span class="qnote">downloads (0 = the general setting)</span></div>
        <div class="k">Schedule</div><div><label><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> Start at</label> <input type="time" data-f="start" value="${esc(s.start || '01:00')}"> until <input type="time" data-f="stop" value="${esc(s.stop || '')}"> <span class="qnote">(empty = no end)</span></div>
        <div class="k">Days</div><div class="days">${DAY_NAMES.map((n, d) => `<label><input type="checkbox" data-day="${d}" ${!s.days || !s.days.length || s.days.includes(d) ? 'checked' : ''}>${n}</label>`).join('')}</div>
        <div class="qacts"><button data-a="start">Start now</button><button data-a="stop">Stop now</button><span style="flex:1"></span>${q.id === 'main' ? '' : '<button data-a="del" class="danger">Delete queue</button>'}</div>`;
      item.addEventListener('change', () => {
        const v = (f) => item.querySelector(`[data-f="${f}"]`);
        q.name = v('name').value.trim() || q.name;
        q.maxActive = Math.max(0, Math.min(10, Number(v('maxActive').value) || 0));
        const days = [...item.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => Number(c.dataset.day));
        q.schedule = { enabled: v('enabled').checked, start: v('start').value, stop: v('stop').value, days: days.length === 7 ? [] : days };
      });
      item.querySelector('[data-a="start"]').onclick = () => api.call('downloads.startQueue', { queue: q.id });
      item.querySelector('[data-a="stop"]').onclick = () => api.call('downloads.stopQueue', { queue: q.id });
      const del = item.querySelector('[data-a="del"]');
      if (del) del.onclick = () => { draft.splice(i, 1); render(); };
      list.appendChild(item);
    });
  };
  render();
  w.querySelector('#qAdd').onclick = () => { draft.push({ id: 'q' + Date.now().toString(36), name: 'Queue ' + draft.length, maxActive: 0, schedule: { enabled: true, start: '01:00', stop: '06:00', days: [] } }); render(); };
  w.querySelector('#qCancel').onclick = closeLayer;
  w.querySelector('#qSave').onclick = async () => { await api.call('downloads.saveQueues', { queues: draft }); await loadQueues(); renderAll(); closeLayer(); };
}

// Refresh link: continue a download whose link stopped working, from a new link to the same file.
function showRefresh(d) {
  const w = modal(`<h2>Refresh link</h2>
    <p>Continue <b>${esc(d.name)}</b> from a new link. What was already downloaded is kept.</p>
    ${d.pageUrl ? `<p><button class="pri" id="rPage">Open the download page</button><br><span style="color:var(--fg3);font-size:12px">Then start the download (or play the video) there again. NovaDM picks up the new link and continues.</span></p>` : ''}
    <p>Or paste a new link to the same file:</p>
    <p><input type="text" id="rUrl" placeholder="https://" style="width:100%" spellcheck="false"></p>
    <p class="err" id="rErr" hidden></p>
    <div class="foot"><button id="rCancel">Cancel</button><button class="pri" id="rUse">Use this link</button></div>`);
  w.querySelector('#rCancel').onclick = closeLayer;
  const page = w.querySelector('#rPage');
  if (page) page.onclick = async () => {
    const r = await api.call('downloads.refreshFromPage', { id: d.id });
    if (r && r.ok) closeLayer(); else { const e = w.querySelector('#rErr'); e.textContent = (r && r.error) || 'Could not open the page'; e.hidden = false; }
  };
  w.querySelector('#rUse').onclick = async () => {
    const btn = w.querySelector('#rUse');
    btn.disabled = true; btn.textContent = 'Checking…';
    const r = await api.call('downloads.refreshLink', { id: d.id, url: w.querySelector('#rUrl').value });
    if (r && r.ok) return closeLayer();
    btn.disabled = false; btn.textContent = 'Use this link';
    const e = w.querySelector('#rErr'); e.textContent = (r && r.error) || 'That link did not work'; e.hidden = false;
  };
}

function showInfo(title, text) {
  const w = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="foot"><button class="pri" id="iOk">OK</button></div>`);
  w.querySelector('#iOk').onclick = closeLayer;
}

function showNotice(text) {
  const w = modal(`<h2>Not possible yet</h2><p>${esc(text)}</p><div class="foot"><button class="pri" id="nOk">OK</button></div>`);
  w.querySelector('#nOk').onclick = closeLayer;
}

function confirmDelete(list) {
  const done = list.filter((d) => d.state === 'done').length;
  const w = modal(`<h2>Delete ${list.length === 1 ? 'this download' : list.length + ' downloads'}?</h2>
    <p>${list.length === 1 ? `<b>${esc(list[0].name)}</b><br>` : ''}${done ? 'The file will be deleted from your computer.' : 'The partly downloaded data will be deleted.'} This can't be undone.</p>
    <div class="foot"><button id="dCancel">Cancel</button><button class="danger" id="dOk">Delete</button></div>`);
  w.querySelector('#dCancel').onclick = closeLayer;
  w.querySelector('#dOk').onclick = () => {
    for (const d of list) { api.call('downloads.cancel', { id: d.id, deleteFile: true }); selected.delete(d.id); }
    closeLayer();
  };
}

async function showProperties(id) {
  const p = await api.call('downloads.properties', { id });
  if (!p) return;
  const row = (k, v) => `<div class="prop"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  // Page link opens in a new tab; the download link is copied (opening it would just start it again).
  const link = (u, action) => u ? `<a data-act="${action}" title="${action === 'page' ? 'Open in a new tab' : 'Click to copy'}">${esc(u)}</a>` : '—';
  const stateLabel = { downloading: 'Downloading', connecting: 'Connecting', queued: 'Queued', paused: 'Paused', error: 'Failed', done: 'Finished' }[p.state] || p.state;
  const extra = [];
  if (p.meta && p.meta.duration) extra.push(`Duration ${fmtClock(p.meta.duration)}`);
  if (p.meta && p.meta.width) extra.push(`Resolution ${p.meta.width} × ${p.meta.height}`);
  if (p.segments) extra.push(`${p.doneSegments || 0} of ${p.segments} parts`);
  if (p.connections) extra.push(`${p.connections} connection${p.connections === 1 ? '' : 's'}${p.directConnections ? ` (${p.directConnections} direct)` : ''}`);
  if (p.kind === 'hls') extra.push(p.convertTs ? 'Stream saved as MP4' : 'Stream saved as received');
  const w = modal(`<h2>Properties</h2><div class="props">
    ${row('Name', esc(p.name))}
    ${row('Status', stateLabel + (p.error ? ` — ${esc(p.error)}` : ''))}
    ${row('Download page', link(p.pageUrl, 'page'))}
    ${row('Download link', link(p.sourceUrl, 'copy'))}
    ${p.mirrors.length ? row('Mirrors', p.mirrors.map(esc).join('<br>')) : ''}
    ${row('Path', esc(p.savePath))}
    ${row('Resume', p.resumable === false ? 'No (server doesn’t support it)' : p.resumable ? 'Yes' : 'Unknown until it starts')}
    ${row('Size', p.size > 0 ? `${p.sizeIsEstimate ? 'About ' : ''}${fmtSize(p.size)} (${Math.round(p.size).toLocaleString()} bytes)` : 'Unknown')}
    ${row('Downloaded', `${fmtSize(p.received)} (${Math.round(p.received).toLocaleString()} bytes)`)}
    ${row('Average speed', p.avgSpeed ? fmtSize(p.avgSpeed) + '/s' : '—')}
    ${row('Date added', fmtDate(p.addedAt))}
    ${row('Active time', p.activeMs ? fmtDur(p.activeMs) : '—')}
    ${row(p.state === 'done' ? 'Date finished' : 'Last written', fmtDate(p.state === 'done' ? p.completedAt : p.modifiedAt))}
    ${extra.length ? row('Additional information', extra.map(esc).join('<br>')) : ''}
    ${p.state !== 'done' && !p.native ? row('Speed limit', `<input type="number" id="pLimit" min="0" step="100" value="${p.speedLimitKBps || 0}" style="width:90px"> KB/s for this download <button id="pLimitSet">Set</button> <span style="color:var(--fg3)">(0 = no limit)</span>`) : ''}
    ${p.expectedHash ? row('Checksum check', `${esc(VERIFY_TEXT[p.verify] ? VERIFY_TEXT[p.verify].replace(/<[^>]+>/g, '') : 'When the download finishes')}<br><span class="hash">${esc(p.expectedHash)}</span>`) : ''}
    ${p.infoHash ? row('Info hash', `<span class="hash">${esc(p.infoHash)}</span>`) : ''}
    ${p.btFiles && p.btFiles.length > 1 ? row('Files', p.btFiles.map((f, i) => `${!p.selectFiles || p.selectFiles.split(',').includes(String(i + 1)) ? '✓' : '·'} ${esc(f.path)} (${fmtSize(f.length)})`).join('<br>')) : ''}
    ${p.native ? row('Handled by', 'The browser (this kind of link cannot be fetched again, so it cannot resume after NovaDM closes)') : ''}
    ${p.incognito ? row('Private', 'Started from a private tab: not kept in the list after NovaDM closes') : ''}
    ${row('MD5 checksum', '<span class="hash" id="h-md5"></span> <button id="c-md5">Calculate</button>')}
    ${row('SHA-256 checksum', '<span class="hash" id="h-sha256"></span> <button id="c-sha256">Calculate</button>')}
  </div><div class="foot"><button id="pFolder">Show in folder</button><button class="pri" id="pClose">Close</button></div>`);
  w.querySelector('#pClose').onclick = closeLayer;
  w.querySelector('#pFolder').onclick = () => api.call('downloads.showInFolder', { id });
  const limitBtn = w.querySelector('#pLimitSet');
  if (limitBtn) limitBtn.onclick = async () => {
    await api.call('downloads.setSpeedLimit', { id, kbps: Number(w.querySelector('#pLimit').value) || 0 });
    limitBtn.textContent = 'Saved'; setTimeout(() => { limitBtn.textContent = 'Set'; }, 900);
  };
  w.querySelectorAll('a[data-act]').forEach((a) => {
    a.onclick = () => {
      if (a.dataset.act === 'page') api.call('downloads.openPage', { id });
      else { api.call('downloads.copyLink', { id }); a.title = 'Copied'; a.style.opacity = '.6'; setTimeout(() => { a.style.opacity = ''; }, 600); }
    };
  });
  for (const algo of ['md5', 'sha256']) {
    const btn = w.querySelector('#c-' + algo);
    const out = w.querySelector('#h-' + algo);
    if (p.state !== 'done') { btn.disabled = true; btn.title = 'Available when the download has finished'; btn.style.opacity = '.5'; continue; }
    btn.onclick = async () => {
      btn.textContent = 'Calculating…'; btn.disabled = true;
      try {
        const r = await api.call('downloads.checksum', { id, algo });
        out.textContent = r.hash; btn.remove();
      } catch (e) {
        out.textContent = 'Could not read the file.'; btn.textContent = 'Calculate'; btn.disabled = false;
      }
    };
  }
}

// ---- toolbar ----
$('resumeAll').onclick = () => api.call('downloads.resumeAll');
$('pauseAll').onclick = () => api.call('downloads.pauseAll');
$('openFolder').onclick = () => api.call('downloads.openFolder');
$('queuesBtn').onclick = () => loadQueues().then(showQueues);
$('openTorrent').onclick = () => api.call('downloads.openTorrent');
$('exportBtn').onclick = async () => { const r = await api.call('downloads.export'); if (r && r.ok) showInfo('Exported', `${r.downloads} downloads and your settings were saved. Passwords, keys and cookies are not in the file.`); };
$('importBtn').onclick = async () => {
  const r = await api.call('downloads.import');
  if (r && r.ok) showInfo('Imported', `${r.added} downloads added (${r.skipped} already here), ${r.settings} settings changed.`);
  else if (r && r.error) showNotice(r.error);
};
$('afterAllDone').onchange = () => api.call('downloads.setAfterAllDone', { action: $('afterAllDone').value });
loadQueues().then(renderAll);
setInterval(loadQueues, 15000);
$('clearDone').onclick = () => api.call('downloads.clearCompleted');
async function addUrl() {
  const v = $('addUrl').value.trim();
  if (!v) return;
  const r = await api.call('downloads.addUrl', { url: v });
  if (r && r.ok) $('addUrl').value = '';
  else { $('addUrl').setCustomValidity((r && r.error) || 'Enter a link that starts with http:// or https://'); $('addUrl').reportValidity(); }
}
$('addBtn').onclick = addUrl;
$('addUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(); });
$('addUrl').addEventListener('input', () => $('addUrl').setCustomValidity(''));
$('q').addEventListener('input', () => { state.q = $('q').value; renderAll(); });

const sel = () => items.filter((d) => selected.has(d.id));
$('bResume').onclick = () => sel().forEach((d) => d.state !== 'done' && api.call('downloads.resume', { id: d.id }));
$('bPause').onclick = () => sel().forEach((d) => api.call('downloads.pause', { id: d.id }));
$('bRemove').onclick = () => { sel().forEach((d) => (d.state === 'done' ? api.call('downloads.remove', { id: d.id }) : null)); selected.clear(); renderAll(); };
$('bDelete').onclick = () => { const s = sel(); if (s.length) confirmDelete(s); };
$('bNone').onclick = () => { selected.clear(); renderAll(); };

// ---- data ----
function apply(data) {
  items = data.list || [];
  summary = data.summary || {};
  renderAll();
}

if (api) {
  api.call('downloads.list').then(apply);
  api.on('downloads', apply);
  // Running time / ETA text refreshes even without new data.
  setInterval(() => { if (items.some((d) => d.state === 'downloading')) renderList(); }, 1000);
}
