'use strict';
const bridge = window.novadmInternal;
const $ = (id) => document.getElementById(id);
let current = {};

const TOGGLES = ['adblock', 'categoryFolders', 'convertTsToMp4', 'pageTitleNames', 'autoResume', 'notifyOnComplete', 'clipboardWatch', 'startWithWindows', 'preventSleep', 'markOfTheWeb', 'torrentAskFiles', 'openTorrentFiles', 'torrentTrackerList', 'apiEnabled', 'magnetHandler', 'extractArchives', 'deleteAfterExtract'];
const TEXTS = ['clipboardExtensions', 'proxyServer', 'proxyBypass', 'proxyPac', 'proxyUser', 'afterArgs', 'webhookUrl'];
const NUMBERS = { connections: [1, 32], maxActive: [1, 10], speedLimitKBps: [0, 1e7], minMediaKB: [0, 1e6], torrentSeedMinutes: [0, 100000], torrentUploadKBps: [0, 1e7], apiPort: [1024, 65535] };
const SELECTS = ['secureDns', 'popupMode', 'searchEngine', 'downloadTransport', 'proxyMode', 'proxyType', 'closeToTray', 'scanDownloads', 'theme', 'accent'];

function flashSaved() {
  const s = $('saved');
  s.classList.add('on');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => s.classList.remove('on'), 1200);
}

async function save(patch) {
  current = await bridge.setSettings(patch);
  render();
  flashSaved();
  // DNS status updates after the new servers are tested.
  if ('secureDns' in patch || 'secureDnsCustom' in patch) setTimeout(async () => { current = await bridge.getSettings(); renderDns(); }, 4500);
}

function fillOptions() {
  const dns = $('secureDns');
  dns.innerHTML = '';
  for (const [key, p] of Object.entries(current.dnsProviders || {})) dns.add(new Option(p.name, key));
  dns.add(new Option('Custom', 'custom'));
  dns.add(new Option('Off (use network DNS)', 'off'));
  const se = $('searchEngine');
  se.innerHTML = '';
  for (const [key, e] of Object.entries(current.searchEngines || {})) se.add(new Option(e.name, key));
}

function renderDns() {
  const st = current.dnsStatus || {};
  const el = $('dnsStatus');
  el.className = 'status';
  if (st.mode === 'secure') { el.textContent = 'Active: lookups are encrypted.'; el.classList.add('ok'); }
  else if (st.mode === 'automatic') { el.textContent = st.note || 'Encrypted when possible, normal DNS as fallback.'; el.classList.add('warn'); }
  else if (st.mode === 'off') { el.textContent = 'Off: using your network’s DNS.'; }
  else {
    // Still testing the DNS servers at startup: show progress and check again shortly.
    el.textContent = 'Checking…';
    clearTimeout(renderDns.retry);
    renderDns.retry = setTimeout(async () => { current = await bridge.getSettings(); renderDns(); }, 1000);
  }
  $('customRow').hidden = current.secureDns !== 'custom';
}

function render() {
  for (const k of TOGGLES) $(k).checked = !!current[k];
  for (const k of Object.keys(NUMBERS)) if (document.activeElement !== $(k)) $(k).value = current[k];
  for (const k of SELECTS) $(k).value = current[k];
  for (const k of TEXTS) if (document.activeElement !== $(k)) $(k).value = current[k] || '';
  if (document.activeElement !== $('torrentSeedRatio')) $('torrentSeedRatio').value = current.torrentSeedRatio ?? 1;
  $('askEach').checked = !current.skipEditor;
  const pm = current.proxyMode;
  $('proxyManualRow').hidden = pm !== 'manual';
  $('proxyBypassRow').hidden = pm !== 'manual';
  $('proxyPacRow').hidden = pm !== 'pac';
  $('proxyAuthRow').hidden = pm !== 'manual' && pm !== 'pac';
  $('proxyPass').placeholder = current.proxyHasPassword ? 'Password saved' : 'Password';
  $('afterProgramShow').textContent = current.afterProgram || 'None';
  renderRules();
  if (document.activeElement !== $('secureDnsCustom')) $('secureDnsCustom').value = current.secureDnsCustom || '';
  $('downloadDir').textContent = current.downloadDir || '';
  $('downloadDir').title = current.downloadDir || '';
  renderDns();
}

async function renderExtensions() {
  const host = $('extList');
  let data;
  try { data = await bridge.call('extensions.list'); } catch { data = { list: [] }; }
  host.innerHTML = '';
  if (!data.ready) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<div class="lbl"><span>Loading extensions…</span></div>';
    host.appendChild(row);
    setTimeout(renderExtensions, 1500);
    return;
  }
  if (!data.list.length) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<div class="lbl"><span>No extensions installed.</span></div>';
    host.appendChild(row);
    return;
  }
  for (const e of data.list) {
    const row = document.createElement('div'); row.className = 'row';
    const lbl = document.createElement('div'); lbl.className = 'lbl';
    const b = document.createElement('b'); b.textContent = `${e.name} ${e.version ? '· ' + e.version : ''}`;
    const s = document.createElement('span'); s.textContent = e.description || e.id;
    lbl.append(b, s);
    const rm = document.createElement('button'); rm.textContent = 'Remove';
    rm.onclick = async () => { rm.disabled = true; rm.textContent = 'Removing…'; await bridge.call('extensions.remove', { id: e.id }); renderExtensions(); };
    row.append(lbl, rm);
    host.appendChild(row);
  }
}

async function init() {
  if (!bridge) return;
  $('openStore').onclick = () => bridge.call('extensions.openStore');
  renderExtensions();
  current = await bridge.getSettings();
  fillOptions();
  render();
  for (const k of TOGGLES) $(k).addEventListener('change', () => save({ [k]: $(k).checked }));
  for (const k of SELECTS) $(k).addEventListener('change', () => save({ [k]: $(k).value }));
  $('torrentSeedRatio').addEventListener('change', () => save({ torrentSeedRatio: Math.max(0, Math.min(100, Number($('torrentSeedRatio').value) || 0)) }));
  for (const [k, [min, max]] of Object.entries(NUMBERS)) {
    $(k).addEventListener('change', () => {
      let v = Math.round(Number($(k).value));
      if (!Number.isFinite(v)) v = current[k];
      v = Math.min(max, Math.max(min, v));
      save({ [k]: v });
    });
  }
  $('secureDnsCustom').addEventListener('change', () => save({ secureDnsCustom: $('secureDnsCustom').value.trim() }));
  for (const k of TEXTS) $(k).addEventListener('change', () => save({ [k]: $(k).value.trim() }));
  $('askEach').addEventListener('change', () => save({ skipEditor: !$('askEach').checked }));
  $('proxyPass').addEventListener('change', async () => {
    const r = await bridge.setProxyPassword($('proxyPass').value);
    $('proxyPass').value = '';
    if (r && r.ok === false) $('proxyPassState').textContent = r.error;
    current = await bridge.getSettings(); render(); flashSaved();
  });
  $('chooseDir').addEventListener('click', async () => { current = await bridge.chooseDownloadDir(); render(); });
  initFfmpeg();
  initAria2();
  initRules();
  initIntegration();
  initYtdlp();
  initSiteExtensions();
}

// ---- FFmpeg (Video tools) ----
function renderFfmpeg(st) {
  const el = $('ffStatus');
  el.className = 'status';
  if (st.installing) { el.textContent = 'Installing…'; return; }
  if (st.installed) {
    el.textContent = `FFmpeg ${st.version} is ready` + (st.custom ? ` (${st.path})` : '');
    el.classList.add('ok');
  } else el.textContent = 'Not installed.';
  $('ffInstall').hidden = !!st.installed && !st.custom;
  $('ffInstall').textContent = st.installed ? 'Install NovaDM\'s copy' : 'Install';
  $('ffRemove').hidden = !st.installed;
}

async function initFfmpeg() {
  const refresh = async () => { try { renderFfmpeg(await bridge.call('ffmpeg.status')); } catch {} };
  const phaseText = { checking: 'Finding the newest build…', downloading: 'Downloading…', verifying: 'Checking the download…', unpacking: 'Unpacking…' };
  bridge.on('ffmpeg', (p) => {
    const el = $('ffStatus');
    const bar = $('ffBar');
    if (p.phase === 'error') { el.textContent = p.error; el.className = 'status warn'; bar.hidden = true; return; }
    if (p.phase === 'done') { bar.hidden = true; refresh(); return; }
    el.textContent = phaseText[p.phase] || p.phase;
    if (p.phase === 'downloading' && p.size > 0) {
      bar.hidden = false;
      bar.firstElementChild.style.width = Math.round((p.received / p.size) * 100) + '%';
      el.textContent = `Downloading… ${Math.round(p.received / 1048576)} of ${Math.round(p.size / 1048576)} MB`;
    }
  });
  $('ffInstall').onclick = async () => {
    $('ffInstall').disabled = true;
    const r = await bridge.call('ffmpeg.install');
    $('ffInstall').disabled = false;
    if (r && r.ok) renderFfmpeg(r.status);
  };
  $('ffChoose').onclick = async () => renderFfmpeg(await bridge.call('ffmpeg.choose'));
  $('ffRemove').onclick = async () => renderFfmpeg(await bridge.call('ffmpeg.uninstall'));
  refresh();
}

// ---- rules: categories/folders and per-site settings ----
const CAT_NAMES = { video: 'Video', music: 'Music', images: 'Images', documents: 'Documents', archives: 'Archives', programs: 'Programs', other: 'Other' };
function renderRules() {
  const list = $('ruleList');
  if (!list || list.contains(document.activeElement)) return;
  list.innerHTML = '';
  (current.categoryRules || []).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="mini"><select data-k="by"><option value="type">File type</option><option value="site">Site</option><option value="text">Address contains</option></select>
      <input type="text" data-k="value" placeholder="e.g. psd ai" spellcheck="false"> <span>→</span>
      <select data-k="category">${Object.entries(CAT_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input type="text" data-k="folder" placeholder="Folder (optional)" spellcheck="false"><button data-a="pick">…</button><button data-a="del">Remove</button></div>`;
    for (const el of row.querySelectorAll('[data-k]')) el.value = r[el.dataset.k] || (el.dataset.k === 'category' ? 'other' : '');
    row.addEventListener('change', () => saveRules());
    row.querySelector('[data-a="pick"]').onclick = async () => { const f = await bridge.settingsOp('chooseFolder'); if (f && f.folder) { row.querySelector('[data-k="folder"]').value = f.folder; saveRules(); } };
    row.querySelector('[data-a="del"]').onclick = () => { row.remove(); saveRules(); };
    list.append(row);
  });
  const sites = $('siteList');
  if (sites.contains(document.activeElement)) return;
  sites.innerHTML = '';
  (current.siteSettings || []).forEach((s) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="mini capped"><label>Site<input type="text" data-k="site" placeholder="example.com" spellcheck="false"></label>
      <label>Connections<input type="number" data-k="connections" min="0" max="32" title="0 = the general setting"></label>
      <label>Limit KB/s<input type="number" data-k="speedLimitKBps" min="0" step="50" title="0 = no limit"></label>
      <label>Browser name<input type="text" data-k="userAgent" placeholder="Optional" spellcheck="false"></label>
      <label>Sign-in<input type="text" data-k="user" placeholder="User name" spellcheck="false"></label>
      <label>Password<input type="password" data-p="1" placeholder="${s.hasPassword ? 'Saved' : 'None'}"></label>
      <button data-a="del">Remove</button></div>`;
    for (const el of row.querySelectorAll('[data-k]')) el.value = s[el.dataset.k] ?? (el.type === 'number' ? 0 : '');
    row.addEventListener('change', async (e) => {
      if (e.target.dataset.p) { await saveSites(); await bridge.settingsOp('sitePassword', { site: row.querySelector('[data-k="site"]').value.trim(), password: e.target.value }); e.target.value = ''; current = await bridge.getSettings(); renderRules(); flashSaved(); return; }
      saveSites();
    });
    row.querySelector('[data-a="del"]').onclick = () => { row.remove(); saveSites(); };
    sites.append(row);
  });
}
function rowsOf(id) {
  return [...$(id).querySelectorAll('.row')].map((row) => {
    const o = {};
    for (const el of row.querySelectorAll('[data-k]')) o[el.dataset.k] = el.type === 'number' ? Number(el.value) || 0 : el.value.trim();
    return o;
  });
}
function saveRules() { return save({ categoryRules: rowsOf('ruleList').filter((r) => r.value) }); }
function saveSites() { return save({ siteSettings: rowsOf('siteList').filter((s) => s.site) }); }
function initRules() {
  $('ruleAdd').onclick = async () => { await save({ categoryRules: [...(current.categoryRules || []), { by: 'type', value: '', category: 'other', folder: '' }] }); renderRules(); };
  $('siteAdd').onclick = async () => { await save({ siteSettings: [...(current.siteSettings || []), { site: '', connections: 0, speedLimitKBps: 0, userAgent: '', user: '' }] }); renderRules(); };
  $('afterProgramChoose').onclick = async () => { current = await bridge.settingsOp('chooseProgram'); render(); };
  $('afterProgramClear').onclick = () => save({ afterProgram: '' });
}

// ---- site extensions ----
function renderSiteExtensions(list) {
  const host = $('seList');
  host.innerHTML = '';
  for (const e of list || []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="lbl"><b></b><span></span></div><label class="sw"><input type="checkbox"><i></i></label><button>Remove</button>`;
    row.querySelector('b').textContent = `${e.name} ${e.version}`;
    row.querySelector('span').textContent = (e.description ? e.description + ' · ' : '') + 'Reads: ' + e.matches.join(', ');
    const cb = row.querySelector('input');
    cb.checked = e.enabled;
    cb.onchange = async () => renderSiteExtensions(await bridge.call('siteext.setEnabled', { id: e.id, enabled: cb.checked }));
    row.querySelector('button').onclick = async () => renderSiteExtensions(await bridge.call('siteext.remove', { id: e.id }));
    host.append(row);
  }
}
function siteExtMessage(text) { $('seMsg').hidden = !text; $('seMsgText').textContent = text || ''; }
async function initSiteExtensions() {
  const refresh = async () => { try { renderSiteExtensions(await bridge.call('siteext.list')); } catch {} };
  const after = (r) => { siteExtMessage(r && r.error ? r.error : r && r.ok ? `Installed ${r.name}.` : ''); refresh(); };
  $('seFolder').onclick = async () => after(await bridge.call('siteext.installFolder'));
  $('seGitHubAdd').onclick = async () => { siteExtMessage('Downloading…'); after(await bridge.call('siteext.installGitHub', { url: $('seGitHub').value.trim() })); };
  refresh();
}

// ---- yt-dlp (Video tools) ----
function initYtdlp() {
  const render = (st) => {
    const el = $('ytStatus');
    el.className = 'status';
    if (st.installing) el.textContent = 'Installing…';
    else if (st.installed) { el.textContent = `yt-dlp ${st.version} is ready` + (st.custom ? ` (${st.path})` : ''); el.classList.add('ok'); }
    else el.textContent = 'Not installed.';
    $('ytInstall').hidden = !!st.installed && !st.custom;
    $('ytInstall').textContent = st.installed ? 'Install NovaDM\'s copy' : 'Install';
    $('ytRemove').hidden = !st.installed;
  };
  const refresh = async () => { try { render(await bridge.call('ytdlp.status')); } catch {} };
  bridge.on('ytdlp', (p) => {
    const el = $('ytStatus'); const bar = $('ytBar');
    if (p.phase === 'error') { el.textContent = p.error; el.className = 'status warn'; bar.hidden = true; return; }
    if (p.phase === 'done') { bar.hidden = true; refresh(); return; }
    el.textContent = { checking: 'Reading the release…', downloading: 'Downloading…', verifying: 'Checking the download…' }[p.phase] || p.phase;
    if (p.phase === 'downloading' && p.size > 0) { bar.hidden = false; bar.firstElementChild.style.width = Math.round((p.received / p.size) * 100) + '%'; }
  });
  $('ytInstall').onclick = async () => { $('ytInstall').disabled = true; const r = await bridge.call('ytdlp.install'); $('ytInstall').disabled = false; if (r && r.ok) render(r.status); };
  $('ytChoose').onclick = async () => render(await bridge.call('ytdlp.choose'));
  $('ytRemove').onclick = async () => render(await bridge.call('ytdlp.uninstall'));
  refresh();
}

// ---- other browsers and apps (local API) ----
async function renderIntegration() {
  let st;
  try { st = await bridge.call('integration.status'); } catch { return; }
  const el = $('apiStatus');
  el.className = 'status';
  if (!st.enabled) el.textContent = 'Off.';
  else if (st.running) { el.textContent = `On: http://127.0.0.1:${st.port}`; el.classList.add('ok'); }
  else { el.textContent = st.error || 'Starting…'; el.classList.add('warn'); }
  $('apiKeyRow').hidden = !st.enabled;
  $('apiPortRow').hidden = !st.enabled;
  $('apiKey').textContent = st.key || '';
}
function initIntegration() {
  $('apiCopy').onclick = async () => { await bridge.call('integration.copyKey'); $('apiCopy').textContent = 'Copied'; setTimeout(() => { $('apiCopy').textContent = 'Copy'; }, 1000); };
  $('apiNewKey').onclick = async () => { await bridge.call('integration.newKey'); renderIntegration(); };
  $('openExtFolder').onclick = () => bridge.call('integration.openExtensionFolder');
  for (const id of ['apiEnabled', 'apiPort']) $(id).addEventListener('change', () => setTimeout(renderIntegration, 400));
  renderIntegration();
}

// ---- aria2 (Torrents) ----
async function initAria2() {
  const render = (st) => {
    const el = $('a2Status');
    el.className = 'status';
    if (st.installing) el.textContent = 'Installing…';
    else if (st.installed) { el.textContent = `aria2 ${st.version || ''} is ready` + (st.custom ? ` (${st.path})` : ''); el.classList.add('ok'); }
    else el.textContent = 'Not installed: torrents and magnet links can’t be downloaded yet.';
    $('a2Install').hidden = !!st.installed && !st.custom;
    $('a2Remove').hidden = !st.installed;
  };
  const refresh = async () => { try { render(await bridge.call('torrents.status')); } catch {} };
  bridge.on('aria2', (p) => {
    const el = $('a2Status');
    const bar = $('a2Bar');
    if (p.phase === 'error') { el.textContent = p.error; el.className = 'status warn'; bar.hidden = true; return; }
    if (p.phase === 'done') { bar.hidden = true; refresh(); return; }
    el.textContent = { downloading: 'Downloading…', verifying: 'Checking the download…', unpacking: 'Unpacking…' }[p.phase] || p.phase;
    if (p.phase === 'downloading' && p.size > 0) { bar.hidden = false; bar.firstElementChild.style.width = Math.round((p.received / p.size) * 100) + '%'; }
  });
  $('a2Install').onclick = async () => { $('a2Install').disabled = true; const r = await bridge.call('torrents.install'); $('a2Install').disabled = false; if (r && r.ok) render(r.status); };
  $('a2Choose').onclick = async () => render(await bridge.call('torrents.choose'));
  $('a2Remove').onclick = async () => render(await bridge.call('torrents.uninstall'));
  refresh();
}

init();
