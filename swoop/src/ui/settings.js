'use strict';
const bridge = window.swoopInternal;
const $ = (id) => document.getElementById(id);
let current = {};

const TOGGLES = ['adblock', 'categoryFolders', 'convertTsToMp4', 'pageTitleNames'];
const NUMBERS = { connections: [1, 32], maxActive: [1, 10], speedLimitKBps: [0, 1e7], minMediaKB: [0, 1e6] };
const SELECTS = ['secureDns', 'popupMode', 'searchEngine'];

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
  for (const [k, [min, max]] of Object.entries(NUMBERS)) {
    $(k).addEventListener('change', () => {
      let v = Math.round(Number($(k).value));
      if (!Number.isFinite(v)) v = current[k];
      v = Math.min(max, Math.max(min, v));
      save({ [k]: v });
    });
  }
  $('secureDnsCustom').addEventListener('change', () => save({ secureDnsCustom: $('secureDnsCustom').value.trim() }));
  $('chooseDir').addEventListener('click', async () => { current = await bridge.chooseDownloadDir(); render(); });
}

init();
