'use strict';
const api = window.novadm;
const pop = document.getElementById('pop');
const content = document.getElementById('content');
let current = null; // 'media' | 'downloads' | 'shields' | 'menu' | 'popup' | 'permission'
let mediaData = { items: [], count: 0, eme: '' };
let dlData = { list: [], summary: {} };
let shieldsData = {};
let addonsData = { missing: [] };

// Position and size of each popover (under its toolbar button; grabber and prompts centered).
const PLACE = {
  media: { right: '186px', width: '380px' },
  grabber: { left: '50%', right: 'auto', transform: 'translateX(-50%)', width: 'min(940px, calc(100% - 32px))', height: 'calc(100% - 24px)' },
  downloads: { right: '102px', width: '400px' },
  shields: { right: '206px', width: '320px' },
  menu: { right: '12px', width: '240px' },
  prompt: { left: '50%', right: 'auto', transform: 'translateX(-50%)', width: '420px' },
  dialog: { left: '50%', right: 'auto', transform: 'translateX(-50%)', width: '480px', top: '40px' },
  tabsearch: { left: '50%', right: 'auto', transform: 'translateX(-50%)', width: '520px', top: '8px' },
};
function place(name) {
  pop.removeAttribute('style');
  pop.className = '';
  Object.assign(pop.style, PLACE[name] || PLACE.menu);
  if (name === 'grabber') pop.classList.add('grab');
  if (name === 'prompt') pop.classList.add('prompt');
  if (name === 'dialog') pop.classList.add('prompt', 'dlg');
}

function close() { api.call('panel.close'); current = null; }
document.getElementById('backdrop').addEventListener('mousedown', close);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

api.on('open-panel', (d) => {
  if (d.name === 'media' && current !== 'media') ytdlpView = null;
  current = d.name;
  place(d.name);
  if (d.name === 'grabber') startGrab();
  render();
});
api.on('close-panel', () => { current = null; });
api.on('media', (d) => { mediaData = d; if (current === 'media') render(); });
api.on('downloads', (d) => { dlData = d; if (current === 'downloads') render(); });
api.on('shields', (d) => { shieldsData = d; if (current === 'shields') render(); });
api.on('addons', (d) => { addonsData = d; if (current === 'menu') render(); });
api.call('addons.state').then((d) => { addonsData = d; }).catch(() => {});
api.on('popup-ask', (d) => showPopupPrompt(d));
api.on('permission-ask', (d) => showPermissionPrompt(d));
api.on('download-ask', (d) => showDownloadAsk(d));
api.on('download-ask-update', (d) => updateDownloadAsk(d));
api.on('links-ask', (d) => showLinksAsk(d));
api.on('afterdone-ask', (d) => showAfterDone(d));
api.on('torrent-files', (d) => showTorrentFiles(d));
api.on('password-warning', (d) => showPasswordWarning(d));

// ---- password warnings (breach.js) ----
function showPasswordWarning(d) {
  if (current && current !== 'password') return; // a question is open: don't cover it
  current = 'password'; place('prompt');
  content.innerHTML = '';
  const title = d.count ? 'This password was found in a data breach' : 'Password sent without encryption';
  const text = d.count
    ? `The password you just used on <b>${esc(d.site)}</b> appears ${d.count.toLocaleString()} time${d.count === 1 ? '' : 's'} in leaked password lists, so attackers try it. Change it on this site and anywhere else you use it.`
    : `<b>${esc(d.site)}</b> isn't using HTTPS, so the password you just entered was sent in readable form. Avoid signing in here on public Wi-Fi, and don't reuse this password.`;
  content.append(el('div', 'hdr', `<div class="t">⚠ ${title}</div>`), el('div', 'q', text));
  const acts = el('div', 'acts');
  const ok = el('button', 'btn pri', 'OK');
  ok.onclick = () => { current = null; api.call('panel.close'); };
  acts.append(ok);
  content.append(acts);
  setTimeout(() => ok.focus(), 30);
}
api.on('omni-suggest', (d) => showSuggestions(d));
api.on('omni-highlight', (d) => highlightSuggestion(d.index));
api.on('omni-hide', () => { if (current === 'omni') { current = null; content.innerHTML = ''; api.call('panel.close'); } });

// ---- address bar suggestions (typed in the toolbar; this list sits right under it) ----
function showSuggestions(d) {
  if (current && current !== 'omni') return; // another panel or a question is open
  current = 'omni';
  place('omni');
  Object.assign(pop.style, { left: Math.max(4, d.left) + 'px', width: d.width + 'px', right: 'auto', top: '2px' });
  content.innerHTML = '';
  const list = el('div', 'body sugg');
  d.items.forEach((it, i) => {
    const row = el('div', 'srow');
    row.dataset.i = i;
    row.append(el('span', 'sic', it.kind === 'bookmark' ? STAR_SVG : CLOCK_SVG));
    const t = el('div', 'stx');
    t.append(el('span', 'stt', esc(it.title || it.url)), el('span', 'surl', esc(it.url)));
    row.append(t);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      api.call(e.button === 1 || e.ctrlKey ? 'tabs.new' : 'nav.go', e.button === 1 || e.ctrlKey ? { url: it.url } : { input: it.url });
      current = null; content.innerHTML = '';
      api.call('panel.close');
      api.call('omni.done');
    });
    list.append(row);
  });
  content.append(list);
}
function highlightSuggestion(i) {
  if (current !== 'omni') return;
  for (const r of content.querySelectorAll('.srow')) r.classList.toggle('sel', Number(r.dataset.i) === i);
}
const STAR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtSize(b) { if (!b || b < 0) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; }
function fmtDur(s) { if (!s) return ''; s = Math.round(s); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60; return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + (h ? '' : x + 's'); }
function fmtSpeed(b) { return b > 0 ? fmtSize(b) + '/s' : ''; }

function render() {
  if (current === 'grabber') return renderGrab();
  if (current === 'media') return renderMedia();
  if (current === 'downloads') return renderDownloads();
  if (current === 'shields') return renderShields();
  if (current === 'menu') return renderMenu();
  if (current === 'tabsearch') return renderTabSearch();
}

// ---- media ----
function renderMedia() {
  content.innerHTML = '';
  const hdr = el('div', 'hdr');
  hdr.append(el('div', 't', 'Detected media'));
  hdr.append(el('div', 'sp'));
  if (mediaData.ytdlp) {
    const yt = el('a', null, 'Find with yt-dlp'); yt.style.marginRight = '12px'; yt.onclick = () => findWithYtdlp();
    hdr.append(yt);
  }
  if (mediaData.items && mediaData.items.length) {
    const all = el('a', null, 'Download all'); all.onclick = () => api.call('media.downloadAll');
    const clr = el('a', null, 'Clear'); clr.style.marginLeft = '12px'; clr.onclick = () => api.call('media.clear');
    hdr.append(all, clr);
  }
  content.append(hdr);
  if (mediaData.eme) content.append(el('div', 'note', 'This site asked for DRM — showing the unprotected version it provided, if any.'));
  if (ytdlpView) content.append(ytdlpView);
  const items = mediaData.items || [];
  if (!items.length) { if (!ytdlpView) content.append(el('div', 'empty', 'No media detected yet.<br>Play a video, and it will appear here.')); return; }
  for (const it of items) content.append(mediaRow(it));
}

// yt-dlp: what it finds on this page, as a short list of choices.
let ytdlpView = null;
async function findWithYtdlp() {
  ytdlpView = el('div', 'body');
  ytdlpView.append(el('div', 'empty', '<div class="spinner"></div>Asking yt-dlp about this page…'));
  render();
  const r = await api.call('media.ytdlpFind');
  ytdlpView = el('div', 'body');
  if (!r || !r.ok) {
    ytdlpView.append(el('div', 'note', esc((r && r.error) || 'yt-dlp found nothing here')));
  } else {
    ytdlpView.append(el('div', 'note', `yt-dlp: <b>${esc(r.title)}</b>${r.duration ? ' · ' + fmtDur(r.duration) : ''}`));
    r.choices.forEach((label, index) => {
      const row = el('div', 'row');
      row.append(el('div', 'meta', `<div class="nm">${esc(label)}</div>`));
      const dl = el('div', 'iconbtn'); dl.title = 'Download'; dl.innerHTML = dlSvg();
      dl.onclick = () => { api.call('media.ytdlpDownload', { index }); flash(dl); };
      row.append(dl);
      ytdlpView.append(row);
    });
    if (!r.choices.length) ytdlpView.append(el('div', 'empty', 'Nothing NovaDM can download was found.'));
  }
  if (current === 'media') render();
}

function mediaRow(it) {
  const row = el('div', 'row');
  const thumb = el('div', 'thumb', it.kind === 'subtitle' ? ccSvg() : playSvg());
  if (it.thumbnail) { thumb.style.backgroundImage = `url("${String(it.thumbnail).replace(/["\\]/g, '')}")`; thumb.innerHTML = ''; }
  const meta = el('div', 'meta');
  meta.append(el('div', 'nm', esc(it.name)));
  const tags = el('div', 'tags');
  if (it.playing) tags.append(el('span', 'tag play', 'Playing'));
  if (it.encryption === 'drm') tags.append(el('span', 'tag drm', 'Protected'));
  if (it.live) tags.append(el('span', 'tag', 'Live'));
  if (it.kind === 'subtitle') tags.append(el('span', 'tag', 'Subtitle'));
  if (it.duration) tags.append(el('span', 'tag', fmtDur(it.duration)));
  const size = it.size > 0 ? it.size : it.sizeEstimate;
  if (size > 0) tags.append(el('span', 'tag', (it.size > 0 ? '' : '~') + fmtSize(size)));
  if (it.mirrors && it.mirrors.length) tags.append(el('span', 'tag', (it.mirrors.length + 1) + ' mirrors'));
  meta.append(tags);
  row.append(thumb, meta);

  let chosenVariant = it.variants && it.variants.length > 1 ? it.variants[0].url : null;
  if (it.variants && it.variants.length > 1) {
    const sel = el('select');
    for (const v of it.variants) { const o = el('option'); o.value = v.url; o.textContent = v.label + (v.sizeEstimate > 0 ? ' · ~' + fmtSize(v.sizeEstimate) : ''); sel.append(o); }
    sel.onchange = () => { chosenVariant = sel.value; };
    meta.append(sel);
  }
  if (it.encryption !== 'drm') {
    const dl = el('div', 'iconbtn'); dl.title = it.live ? 'Record' : 'Download'; dl.innerHTML = dlSvg();
    dl.onclick = () => { api.call('media.download', { id: it.id, variantUrl: chosenVariant }); flash(dl); };
    row.append(dl);
  }
  const x = el('div', 'iconbtn'); x.title = 'Remove'; x.innerHTML = xSvg();
  x.onclick = () => api.call('media.remove', { id: it.id });
  row.append(x);
  return row;
}

function flash(node) { node.style.color = 'var(--ok)'; setTimeout(() => (node.style.color = ''), 900); }

// ---- downloads ----
function renderDownloads() {
  content.innerHTML = '';
  const hdr = el('div', 'hdr');
  hdr.append(el('div', 't', 'Downloads'), el('div', 'sp'));
  const all = el('a', null, 'Show all downloads'); all.onclick = () => { api.call('downloads.openPageTab'); close(); };
  hdr.append(all);
  content.append(hdr);
  const list = dlData.list || [];
  if (!list.length) { content.append(el('div', 'empty', 'No downloads yet.')); }
  for (const d of list) content.append(dlRow(d));
  const foot = el('div', 'foot');
  const input = el('input'); input.placeholder = 'Paste a link to download'; input.style.cssText = 'flex:1;height:28px;border-radius:7px;border:1px solid var(--line);background:var(--bg3);color:var(--fg);padding:0 9px;outline:none;';
  input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) { api.call('downloads.addUrl', { url: input.value.trim() }); input.value = ''; } };
  foot.append(input);
  content.append(foot);
}

function dlRow(d) {
  const row = el('div', 'row');
  const thumb = el('div', 'thumb', catSvg(d.category));
  const meta = el('div', 'meta');
  meta.append(el('div', 'nm', esc(d.name)));
  const tags = el('div', 'tags');
  const pct = Math.round(d.percent || 0);
  const stateText = d.phase === 'metadata' ? 'Getting torrent info…' : d.seeding ? 'Seeding' : d.recording ? 'Recording ' + fmtDur(d.recordedSeconds || 0) : { downloading: fmtSpeed(d.speed) || 'Downloading', connecting: 'Connecting…', paused: 'Paused', queued: 'Queued', done: 'Completed', error: 'Error', scheduled: 'Scheduled' }[d.state] || d.state;
  tags.append(el('span', 'tag', stateText));
  if (d.size > 0) tags.append(el('span', 'tag', fmtSize(d.received) + ' / ' + fmtSize(d.size)));
  else if (d.doneSegments) tags.append(el('span', 'tag', d.doneSegments + '/' + d.segments + ' parts'));
  if (d.state === 'error' && d.error) tags.append(el('span', 'tag drm', esc(d.error).slice(0, 40)));
  meta.append(tags);
  if (d.state === 'downloading' || d.state === 'connecting' || d.state === 'paused') {
    const bar = el('div', 'bar'); const i = el('i'); i.style.width = pct + '%'; bar.append(i); meta.append(bar);
  }
  row.append(thumb, meta);
  const actions = el('div'); actions.style.display = 'flex'; actions.style.gap = '2px';
  const icon = (title, svg, fn) => { const b = el('div', 'iconbtn'); b.title = title; b.innerHTML = svg; b.onclick = fn; return b; };
  if (d.recording) actions.append(icon('Stop recording', stopSvg(), () => api.call('downloads.stopRecording', { id: d.id })));
  else if (d.state === 'downloading' || d.state === 'connecting') actions.append(icon('Pause', pauseSvg(), () => api.call('downloads.pause', { id: d.id })));
  else if (['paused', 'error', 'queued', 'scheduled'].includes(d.state)) actions.append(icon('Resume', playSmSvg(), () => api.call('downloads.resume', { id: d.id })));
  if (d.state === 'done') { actions.append(icon('Open', folderSvg(), () => api.call('downloads.showInFolder', { id: d.id }))); }
  actions.append(icon('Remove', xSvg(), () => api.call(d.state === 'done' ? 'downloads.remove' : 'downloads.cancel', { id: d.id })));
  row.append(actions);
  if (d.state === 'done') row.ondblclick = () => api.call('downloads.openFile', { id: d.id });
  return row;
}

// ---- shields ----
function renderShields() {
  content.innerHTML = '';
  const s = shieldsData;
  content.append(el('div', 'hdr', '<div class="t">Shields</div>'));
  const wrap = el('div'); wrap.style.padding = '12px 14px';
  const site = el('div'); site.style.cssText = 'color:var(--fg2);font-size:12px;margin-bottom:6px;'; site.textContent = s.site || 'this page';
  const big = el('div'); big.style.cssText = 'font-size:26px;font-weight:600;'; big.textContent = s.count || 0;
  const sub = el('div'); sub.style.cssText = 'color:var(--fg3);font-size:12px;margin-bottom:14px;'; sub.textContent = 'items blocked on this page';
  wrap.append(site, big, sub);
  const toggle = el('button', 'btn'); toggle.style.width = '100%';
  toggle.textContent = s.siteEnabled ? 'Shields are UP for this site' : 'Shields are DOWN for this site';
  if (s.siteEnabled) toggle.classList.add('pri');
  toggle.onclick = () => api.call('shields.toggleSite');
  wrap.append(toggle);
  // Tor-style protections (fingerprinting, security level): off for one site if it breaks.
  if (s.protection) {
    const level = { standard: 'Standard', safer: 'Safer', safest: 'Safest' }[s.protection.level] || 'Standard';
    const p = el('button', 'btn'); p.style.cssText = 'width:100%;margin-top:8px;';
    p.textContent = s.protection.siteOn ? `Tor-style protection ON (${level})` : 'Tor-style protection OFF for this site';
    if (s.protection.siteOn) p.classList.add('pri');
    p.title = "Fingerprinting protection and the security level. Turn it off for a site that doesn't work; the page reloads.";
    p.onclick = () => api.call('shields.toggleHardening');
    wrap.append(p);
  }
  if (!s.ready) wrap.append(el('div', 'note', 'Filter lists are still loading…'));
  content.append(wrap);
  const foot = el('div', 'foot');
  foot.append(el('span', null, 'Ad blocking (all sites)'), el('div', 'sp'));
  const g = el('button', 'btn sm'); g.textContent = s.global ? 'On' : 'Off'; if (s.global) g.classList.add('pri');
  g.onclick = () => api.call('shields.setGlobal', { enabled: !s.global });
  foot.append(g);
  content.append(foot);
}

// ---- menu ----
function renderMenu() {
  content.innerHTML = '';
  // Add-ons that aren't installed (the warning on the menu button).
  const missing = addonsData.missing || [];
  if (missing.length) {
    const box = el('div', 'addon-warn', '<div class="t">⚠ Add-ons not installed</div>');
    for (const a of missing) {
      const row = el('div', 'a', `<b>${esc(a.name)}</b> <span class="w">– ${esc(a.why)}</span>`);
      const links = el('div', 'links');
      const install = el('button', 'btn sm pri', 'Install…');
      install.onclick = () => { api.call('tabs.new', { url: 'novadm://settings?section=addons' }); close(); };
      const later = el('button', 'btn sm', 'Don’t remind me');
      later.onclick = () => api.call('addons.dismiss', { id: a.id });
      links.append(install, later);
      row.append(links);
      box.append(row);
    }
    content.append(box);
  }
  const items = [
    ['New tab', 'tabs.new', {}],
    ['New private tab', 'tabs.new', { incognito: true }],
    ['Downloads', 'downloads.openPageTab', {}],
    ['History', 'tabs.new', { url: 'novadm://history' }],
    ['Bookmarks', 'tabs.new', { url: 'novadm://bookmarks' }],
    ['Find in page', 'find.open', {}],
    ['Reader view', 'reader.open', {}],
    ['Detected media', '_panel', 'media'],
    ['Grab page content', '_panel', 'grabber'],
    ['Get extensions (Chrome Web Store)', 'extensions.openStore', {}],
    ['Settings', 'tabs.new', { url: 'novadm://settings' }],
    ['Report a problem…', 'diagnostics.save', {}],
  ];
  for (const [label, method, arg] of items) {
    const mi = el('div', 'menuitem', esc(label));
    mi.onclick = () => { if (method === '_panel') { api.call('panel.open', { name: arg }); } else { api.call(method, arg); close(); } };
    content.append(mi);
  }
}

// ---- tab search (Ctrl+Shift+A) ----
async function renderTabSearch() {
  content.innerHTML = '';
  const { tabs = [] } = await api.call('tabs.list');
  const box = el('input');
  box.placeholder = 'Search open tabs';
  box.spellcheck = false;
  box.style.cssText = 'width:100%;height:42px;padding:0 14px;border:none;border-bottom:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-size:14px;outline:none;';
  const list = el('div', 'sugg ts');
  list.style.cssText = 'max-height:60vh;overflow:auto;';
  let shown = [];
  let sel = 0;
  const go = (t) => { api.call('tabs.select', { id: t.id }); close(); };
  const draw = () => {
    const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = tabs.filter((t) => words.every((w) => `${t.title || ''} ${t.url || ''}`.toLowerCase().includes(w)));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    shown.forEach((t, i) => {
      const row = el('div', 'srow' + (i === sel ? ' sel' : ''), `<div class="stx"><span class="stt">${esc(t.title || 'New tab')}</span><span class="surl">${esc(t.url || '')}</span></div>`);
      row.onmousedown = () => go(t);
      list.append(row);
    });
    if (!shown.length) list.append(el('div', 'note', 'No open tab matches.'));
  };
  box.oninput = () => { sel = 0; draw(); };
  box.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, Math.min(shown.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))); draw(); }
    else if (e.key === 'Enter' && shown[sel]) go(shown[sel]);
  };
  content.append(box, list);
  draw();
  box.focus();
}

// ---- content grabber ----
const KINDS = [['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['document', 'Documents'], ['archive', 'Archives'], ['program', 'Programs']];
const MIN_SIZES = [[0, 'Any size'], [100, 'Hide under 100 px'], [300, 'Hide under 300 px'], [600, 'Hide under 600 px'], [1000, 'Hide under 1000 px']];
const grab = { items: [], title: '', loading: false, kind: 'image', minSize: 300, q: '', selected: new Set(), allTabs: false, subfolder: true, error: '' };

async function startGrab(autoScroll = false) {
  grab.loading = true; grab.error = '';
  if (!autoScroll) grab.selected.clear();
  render();
  try {
    const res = await api.call('grab.scan', { autoScroll, allTabs: grab.allTabs });
    grab.items = res.items || [];
    grab.title = res.title || '';
    // Open on the first type that has something.
    if (!grab.items.some((i) => i.kind === grab.kind)) {
      const first = KINDS.find(([k]) => grab.items.some((i) => i.kind === k));
      if (first) grab.kind = first[0];
    }
  } catch (e) {
    grab.error = 'Could not read this page.';
  }
  grab.loading = false;
  if (current === 'grabber') render();
}

function grabVisible() {
  const q = grab.q.toLowerCase();
  return grab.items.filter((i) => {
    if (i.kind !== grab.kind) return false;
    // Unknown dimensions pass the size filter: they're often the full-size links.
    if (i.kind === 'image' && grab.minSize && i.w && i.h && Math.max(i.w, i.h) < grab.minSize) return false;
    if (q && !(i.name + ' ' + i.alt + ' ' + i.url).toLowerCase().includes(q)) return false;
    return true;
  });
}

function thumbUrl(it) {
  return 'novadm-thumb://img/?u=' + encodeURIComponent(it.url) + '&r=' + encodeURIComponent(it.pageUrl || '');
}

function renderGrab() {
  content.innerHTML = '';
  const hdr = el('div', 'hdr');
  hdr.append(el('div', 't', 'Grab from this page'));
  const sub = el('div', null, esc(grab.title)); sub.style.cssText = 'color:var(--fg3);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
  hdr.append(sub);
  const x = el('div', 'iconbtn', xSvg()); x.title = 'Close'; x.onclick = close;
  hdr.append(x);
  content.append(hdr);

  // Filters
  const bar = el('div', 'gbar');
  const chips = el('div', 'chips');
  for (const [k, label] of KINDS) {
    const n = grab.items.filter((i) => i.kind === k).length;
    if (!n && k !== 'image') continue;
    const c = el('button', 'chip' + (grab.kind === k ? ' on' : ''), `${label} ${n}`);
    c.onclick = () => { grab.kind = k; render(); };
    chips.append(c);
  }
  bar.append(chips, el('div', 'sp'));
  if (grab.kind === 'image') {
    const ms = el('select');
    for (const [v, l] of MIN_SIZES) ms.add(new Option(l, v));
    ms.value = grab.minSize;
    ms.onchange = () => { grab.minSize = Number(ms.value); render(); };
    bar.append(ms);
  }
  const search = el('input', 'gsearch'); search.placeholder = 'Filter'; search.value = grab.q;
  search.oninput = () => { grab.q = search.value; renderGrabBody(); updateGrabFooter(); };
  bar.append(search);
  content.append(bar);

  const body = el('div', 'gbody'); body.id = 'gbody';
  content.append(body);
  renderGrabBody();

  // Footer
  const foot = el('div', 'foot'); foot.id = 'gfoot';
  content.append(foot);
  updateGrabFooter();
}

function renderGrabBody() {
  const body = document.getElementById('gbody');
  if (!body) return;
  body.innerHTML = '';
  if (grab.loading) { body.append(el('div', 'empty', '<div class="spinner"></div>Looking through the page…')); return; }
  if (grab.error) { body.append(el('div', 'empty', esc(grab.error))); return; }
  const list = grabVisible();
  if (!list.length) {
    body.append(el('div', 'empty', grab.items.length ? 'Nothing matches these filters.' : 'Nothing to download found on this page.<br>Try “Load more” if the page loads items as you scroll.'));
    return;
  }
  if (grab.kind === 'image') {
    const grid = el('div', 'grid');
    for (const it of list) {
      const t = el('div', 'tile' + (grab.selected.has(it.url) ? ' sel' : ''));
      t.title = (it.alt ? it.alt + '\n' : '') + it.url;
      const img = el('img'); img.loading = 'lazy'; img.decoding = 'async'; img.src = thumbUrl(it);
      img.onload = () => {
        if (!it.w && img.naturalWidth) {
          it.w = img.naturalWidth; it.h = img.naturalHeight;
          const d = t.querySelector('.dim'); if (d) d.textContent = `${it.w}×${it.h}`;
        }
      };
      img.onerror = () => { img.remove(); t.append(el('div', 'empty', '<span style="font-size:11px">No preview</span>')); };
      t.append(img, el('div', 'ck', grab.selected.has(it.url) ? checkSvg() : ''), el('div', 'dim', it.w ? `${it.w}×${it.h}` : ''));
      t.onclick = () => toggleSel(it, t);
      grid.append(t);
    }
    body.append(grid);
  } else {
    for (const it of list) {
      const row = el('label', 'lrow');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = grab.selected.has(it.url);
      cb.onchange = () => { if (cb.checked) grab.selected.add(it.url); else grab.selected.delete(it.url); updateGrabFooter(); };
      const nm = el('div', 'nm2');
      nm.append(el('div', null, esc(it.alt && it.kind !== 'video' ? `${it.name} — ${it.alt}` : it.name)), el('div', 'u', esc(it.url)));
      row.append(cb, nm);
      if (it.size > 0) row.append(el('span', 'tag', fmtSize(it.size)));
      body.append(row);
    }
  }
}

function toggleSel(it, tile) {
  if (grab.selected.has(it.url)) grab.selected.delete(it.url); else grab.selected.add(it.url);
  const on = grab.selected.has(it.url);
  tile.classList.toggle('sel', on);
  tile.querySelector('.ck').innerHTML = on ? checkSvg() : '';
  updateGrabFooter();
}

function updateGrabFooter() {
  const foot = document.getElementById('gfoot');
  if (!foot) return;
  foot.innerHTML = '';
  const visible = grabVisible();
  const all = el('a', null, 'Select all'); all.onclick = () => { for (const i of visible) grab.selected.add(i.url); renderGrabBody(); updateGrabFooter(); };
  const none = el('a', null, 'None'); none.onclick = () => { grab.selected.clear(); renderGrabBody(); updateGrabFooter(); };
  for (const a of [all, none]) { a.style.color = 'var(--accent)'; a.style.cursor = 'default'; }
  const more = el('button', 'btn sm', 'Load more'); more.title = 'Scroll through the page so lazy-loaded items appear, then scan again';
  more.onclick = () => startGrab(true);
  const tabsLbl = el('label', null, `<input type="checkbox" ${grab.allTabs ? 'checked' : ''}> All tabs`);
  tabsLbl.querySelector('input').onchange = (e) => { grab.allTabs = e.target.checked; startGrab(false); };
  const sub = el('label', null, `<input type="checkbox" ${grab.subfolder ? 'checked' : ''}> Own folder`);
  sub.title = 'Save into a folder named after the page';
  sub.querySelector('input').onchange = (e) => { grab.subfolder = e.target.checked; };
  const n = grab.items.filter((i) => grab.selected.has(i.url)).length;
  const go = el('button', 'btn pri', n ? `Download ${n}` : 'Download');
  go.disabled = !n;
  go.style.opacity = n ? '1' : '.5';
  go.onclick = async () => {
    if (!n) return;
    const items = grab.items.filter((i) => grab.selected.has(i.url));
    await api.call('grab.download', { items, subfolder: grab.subfolder });
    grab.selected.clear();
    go.textContent = `Added ${items.length}`;
    setTimeout(() => { if (current === 'grabber') { renderGrabBody(); updateGrabFooter(); } }, 1200);
  };
  foot.append(all, none, more, tabsLbl, sub, el('div', 'sp'), go);
}

// ---- prompts (pop-up guard, permissions) ----
function showPopupPrompt(d) {
  current = 'popup'; place('prompt');
  content.innerHTML = '';
  const page = esc(hostOf(d.pageUrl) || 'This page');
  const dest = esc(d.url || '');
  let title = 'Open a new window?';
  let text = `<b>${page}</b> is trying to open a pop-up:`;
  if (d.fromClick) { title = 'Open link to another site?'; text = `This link on <b>${page}</b> opens another site in a new tab:`; }
  if (d.reviewed) {
    title = 'Blocked pop-up';
    text = d.reason === 'ad-redirect' ? `NovaDM stopped <b>${page}</b> from sending this tab to a known ad site:`
      : d.reason === 'ad' ? `NovaDM blocked this pop-up from <b>${page}</b> because it goes to a known ad site:`
      : `NovaDM blocked this pop-up from <b>${page}</b>:`;
  }
  content.append(el('div', 'hdr', `<div class="t">${title}</div>`));
  content.append(el('div', 'q', `${text}<br><b style="color:var(--accent)">${dest}</b>`));
  const chk = el('label', 'chk', `<input type="checkbox" id="pp-remember"> Always allow pop-ups from ${page}`);
  content.append(chk);
  const acts = el('div', 'acts');
  const open = el('button', 'btn', 'Open'); open.onclick = () => { respondPopup(d, true); };
  const block = el('button', 'btn pri', d.reviewed ? 'Keep blocked' : 'Block'); block.onclick = () => { respondPopup(d, false); };
  acts.append(block, open);
  content.append(acts);
}
function respondPopup(d, allow) {
  const remember = document.getElementById('pp-remember');
  api.call('popup.respond', { url: d.url, pageUrl: d.pageUrl, allow, always: remember && remember.checked });
  close();
}

function showPermissionPrompt(d) {
  current = 'permission'; place('prompt');
  content.innerHTML = '';
  const label = { media: 'use your camera and microphone', audioCapture: 'use your microphone', videoCapture: 'use your camera', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices' }[d.permission] || ('use ' + d.permission);
  content.append(el('div', 'hdr', '<div class="t">Permission request</div>'));
  content.append(el('div', 'q', `<b>${esc(hostOf(d.origin))}</b> wants to ${esc(label)}.`));
  content.append(el('label', 'chk', '<input type="checkbox" id="pm-remember" checked> Remember my choice'));
  const acts = el('div', 'acts');
  const allow = el('button', 'btn pri', 'Allow'); allow.onclick = () => respondPerm(true);
  const block = el('button', 'btn', 'Block'); block.onclick = () => respondPerm(false);
  acts.append(allow, block);
  content.append(acts);
}
function respondPerm(allow) {
  const r = document.getElementById('pm-remember');
  api.call('permission.respond', { allow, remember: r && r.checked });
  close();
}

function hostOf(u) { try { return new URL(u).host; } catch { return u || ''; } }

// ---- new download dialog ----
let ask = null; // { reqId, nameEdited, origName, folder }
function showDownloadAsk(d) {
  current = 'download-ask'; place('dialog');
  ask = { reqId: d.reqId, nameEdited: false, origName: d.name, folder: d.folder };
  content.innerHTML = '';
  const title = d.origin === 'clipboard' ? 'Download the copied link?' : 'New download';
  content.append(el('div', 'hdr', `<div class="t">${title}</div><div class="sp"></div>${d.incognito ? '<span class="tag">Private tab</span>' : ''}`));
  const frm = el('div', 'frm');
  frm.innerHTML = `
    <div class="k">File name</div><div class="v"><input class="inp" id="na-name" spellcheck="false"></div>
    <div class="k">Size</div><div class="v"><span class="txt" id="na-size"></span></div>
    <div class="k">From</div><div class="v"><span class="txt" id="na-from"></span></div>
    <div class="k">Save to</div><div class="v"><span class="txt" id="na-folder"></span><button class="btn sm" id="na-change">Change</button></div>
    ${queueRow(d.queues, 'na-queue')}`;
  content.append(frm);
  const name = frm.querySelector('#na-name');
  name.value = d.name;
  name.addEventListener('input', () => { ask.nameEdited = name.value !== ask.origName; });
  frm.querySelector('#na-size').textContent = d.size > 0 ? (d.sizeIsEstimate ? 'About ' : '') + fmtSize(d.size) : (d.kind === 'hls' ? 'Stream' : 'Checking…');
  const from = frm.querySelector('#na-from'); from.textContent = hostOf(d.url); from.title = d.url;
  showAskFolder(d.folder);
  frm.querySelector('#na-change').onclick = async () => {
    const r = await api.call('add.chooseFolder', { current: ask.folder });
    if (r && r.folder && ask) { ask.folderChosen = true; showAskFolder(r.folder); }
  };

  if (d.torrent) {
    if (d.torrent.files && d.torrent.files.length > 1) content.append(fileList(d.torrent.files, 'na-files'));
    else if (d.torrent.magnet) content.append(el('div', 'notice', 'You can choose the files once the torrent’s details have arrived from other computers.'));
  }
  const more = el('details', 'more');
  more.innerHTML = `<summary>More options</summary><div class="frm" style="padding:6px 0 0">
    <div class="k">Speed limit</div><div class="v"><input class="inp num" id="na-limit" type="number" min="0" step="100" value="0"><span style="color:var(--fg3);font-size:12px">KB/s for this download (0 = no limit)</span></div>
    <div class="k">Checksum</div><div class="v"><input class="inp" id="na-hash" placeholder="Optional: MD5, SHA-1 or SHA-256 to check" spellcheck="false"></div></div>`;
  content.append(more);

  if (d.duplicate) {
    const n = el('div', 'notice');
    const st = d.duplicate.state === 'done' ? 'already downloaded' : 'already in your list (' + d.duplicate.state + ')';
    n.innerHTML = `<span>This link is ${esc(st)}: <b>${esc(d.duplicate.name)}</b></span><span class="sp"></span>`;
    if (d.duplicate.state !== 'done') { const b = el('button', 'btn sm', 'Resume that one'); b.onclick = () => respondAsk('resumeExisting'); n.append(b); }
    content.append(n);
  }
  const warn = el('div', 'notice warn', '');
  warn.id = 'na-warn'; warn.hidden = true;
  content.append(warn);
  content.append(el('label', 'chk', '<input type="checkbox" id="na-dontask"> Don&#39;t ask again: start downloads right away'));
  const acts = el('div', 'acts');
  const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => close();
  const paused = el('button', 'btn', 'Add paused'); paused.onclick = () => respondAsk('paused');
  const go = el('button', 'btn pri', 'Download'); go.id = 'na-go'; go.onclick = () => respondAsk('start');
  acts.append(cancel, el('div', 'sp'), paused, go);
  content.append(acts);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') respondAsk('start'); });
  setTimeout(() => { name.focus(); const dot = name.value.lastIndexOf('.'); name.setSelectionRange(0, dot > 0 ? dot : name.value.length); }, 30);
}
function showAskFolder(f) {
  if (!ask) return;
  ask.folder = f;
  const x = document.getElementById('na-folder');
  if (x) { x.textContent = f; x.title = f; }
}
function updateDownloadAsk(d) {
  if (current !== 'download-ask' || !ask || ask.reqId !== d.reqId) return;
  const size = document.getElementById('na-size');
  if (d.size > 0) size.textContent = fmtSize(d.size);
  else if (size.textContent === 'Checking…') size.textContent = 'Unknown';
  if (d.name && !ask.nameEdited) { const n = document.getElementById('na-name'); n.value = d.name; ask.origName = d.name; }
  if (d.folder && !ask.folderChosen) showAskFolder(d.folder);
  if (d.warning) { const w = document.getElementById('na-warn'); w.textContent = d.warning; w.hidden = false; }
}
function respondAsk(action) {
  if (!ask) return;
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  const dont = document.getElementById('na-dontask');
  api.call('add.respond', {
    reqId: ask.reqId, action, name: ask.nameEdited ? v('na-name').trim() : '', folder: ask.folder,
    speedLimitKBps: Number(v('na-limit')) || 0, checksum: v('na-hash').trim(), dontAsk: !!(dont && dont.checked),
    queue: v('na-queue') || 'main', selected: checkedFiles('na-files'),
  });
  ask = null; current = null;
}

// Files of a torrent, all ticked; checkedFiles() gives the ticked indexes (0-based) or undefined.
function fileList(files, id) {
  const wrap = el('div', 'links');
  wrap.id = id;
  files.forEach((f, i) => wrap.append(el('label', 'lrow', `<input type="checkbox" data-i="${i}" checked><div class="nm2"><div>${esc(f.path)}</div><div class="u">${fmtSize(f.length)}</div></div>`)));
  return wrap;
}
function checkedFiles(id) {
  const w = document.getElementById(id);
  return w ? [...w.querySelectorAll('input:checked')].map((c) => Number(c.dataset.i)) : undefined;
}

// A magnet link's details have arrived: which files to download?
function showTorrentFiles(d) {
  current = 'torrent-files'; place('dialog');
  ask = { reqId: d.reqId };
  content.innerHTML = '';
  content.append(el('div', 'hdr', `<div class="t">Choose files</div><div class="sp"></div><span class="tag">${esc(d.files.length)} files</span>`));
  content.append(el('div', 'q', `<b>${esc(d.name)}</b>`));
  const list = fileList(d.files, 'tf-files');
  content.append(list);
  const acts = el('div', 'acts');
  const go = el('button', 'btn pri', '');
  const upd = () => { const n = list.querySelectorAll('input:checked').length; go.textContent = n ? `Download ${n}` : 'Download'; go.disabled = !n; };
  const all = el('button', 'btn sm', 'All'); all.onclick = () => { list.querySelectorAll('input').forEach((c) => { c.checked = true; }); upd(); };
  const none = el('button', 'btn sm', 'None'); none.onclick = () => { list.querySelectorAll('input').forEach((c) => { c.checked = false; }); upd(); };
  const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => close();
  list.addEventListener('change', upd); upd();
  go.onclick = () => { api.call('add.respond', { reqId: d.reqId, action: 'start', selected: checkedFiles('tf-files') }); ask = null; current = null; };
  acts.append(all, none, el('div', 'sp'), cancel, go);
  content.append(acts);
}

// Queue choice, only when the user has made queues besides Main.
function queueRow(queues, id) {
  if (!queues || queues.length < 2) return '';
  const opts = queues.map((q) => `<option value="${esc(q.id)}">${esc(q.name)}${q.scheduled ? ' (scheduled)' : ''}</option>`).join('');
  return `<div class="k">Queue</div><div class="v"><select id="${id}" style="height:30px">${opts}</select></div>`;
}

// "When all downloads finish": countdown before closing / sleep / shutdown, with Cancel.
let afterTimer = null;
function showAfterDone(d) {
  current = 'afterdone'; place('prompt');
  content.innerHTML = '';
  content.append(el('div', 'hdr', '<div class="t">All downloads finished</div>'));
  const q = el('div', 'q', '');
  content.append(q);
  const acts = el('div', 'acts');
  const cancel = el('button', 'btn pri', 'Cancel'); cancel.onclick = () => { clearInterval(afterTimer); api.call('afterdone.cancel'); current = null; };
  const now = el('button', 'btn', 'Do it now'); now.onclick = () => { clearInterval(afterTimer); api.call('afterdone.now'); current = null; };
  acts.append(cancel, now);
  content.append(acts);
  const ends = Date.now() + d.seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
    q.innerHTML = `${esc(d.label)} in <b>${left}</b> second${left === 1 ? '' : 's'}.`;
    if (!left) clearInterval(afterTimer);
  };
  clearInterval(afterTimer);
  tick();
  afterTimer = setInterval(tick, 250);
  setTimeout(() => cancel.focus(), 30);
}

// Several links at once: pick which to download.
function showLinksAsk(d) {
  current = 'links-ask'; place('dialog');
  ask = { reqId: d.reqId, folder: '' };
  content.innerHTML = '';
  const title = d.origin === 'clipboard' ? `${d.links.length} download links copied` : `Download ${d.links.length} links`;
  content.append(el('div', 'hdr', `<div class="t">${esc(title)}</div>`));
  const list = el('div', 'links');
  d.links.forEach((l, i) => {
    list.append(el('label', 'lrow', `<input type="checkbox" data-i="${i}" checked><div class="nm2"><div>${esc(l.name)}</div><div class="u">${esc(l.url)}</div></div>`));
  });
  content.append(list);
  const frm = el('div', 'frm', '<div class="k">Save to</div><div class="v"><span class="txt" id="la-folder"></span><button class="btn sm" id="la-change">Change</button></div>' + queueRow(d.queues, 'la-queue'));
  content.append(frm);
  const showFolder = () => { const x = document.getElementById('la-folder'); x.textContent = ask.folder || 'Sorted by file type'; x.title = ask.folder || ''; };
  showFolder();
  frm.querySelector('#la-change').onclick = async () => {
    const r = await api.call('add.chooseFolder', { current: d.folder });
    if (r && r.folder && ask) { ask.folder = r.folder; showFolder(); }
  };
  const acts = el('div', 'acts');
  const go = el('button', 'btn pri', '');
  go.id = 'la-go';
  const count = () => list.querySelectorAll('input:checked').length;
  const upd = () => { go.textContent = `Download ${count()}`; go.disabled = !count(); };
  const all = el('button', 'btn sm', 'All'); all.onclick = () => { list.querySelectorAll('input').forEach((c) => { c.checked = true; }); upd(); };
  const none = el('button', 'btn sm', 'None'); none.onclick = () => { list.querySelectorAll('input').forEach((c) => { c.checked = false; }); upd(); };
  const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = () => close();
  list.addEventListener('change', upd);
  upd();
  go.onclick = () => {
    const selected = [...list.querySelectorAll('input:checked')].map((c) => Number(c.dataset.i));
    const q = document.getElementById('la-queue');
    api.call('add.respond', { reqId: ask.reqId, action: 'start', selected, folder: ask.folder, queue: q ? q.value : 'main' });
    ask = null; current = null;
  };
  acts.append(all, none, el('div', 'sp'), cancel, go);
  content.append(acts);
}

// ---- icons ----
function playSvg() { return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
function playSmSvg() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
function stopSvg() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'; }
function pauseSvg() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; }
function ccSvg() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 11h2M8 14h2M14 11h2M14 14h2"/></svg>'; }
function dlSvg() { return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5"/><path d="M5 19h14"/></svg>'; }
function checkSvg() { return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>'; }
function xSvg() { return '<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'; }
function folderSvg() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'; }
function catSvg(cat) {
  const m = { video: playSvg(), music: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M9 18V5l12-2v13"/></svg>' };
  return m[cat] || '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
}
