'use strict';
const $ = (id) => document.getElementById(id);
const { DEFAULTS } = globalThis.NovaLib;
const FIELDS = ['key', 'port', 'intercept', 'minSizeMB', 'types', 'skipHosts'];

chrome.storage.local.get(DEFAULTS).then((s) => {
  for (const f of FIELDS) {
    if ($(f).type === 'checkbox') $(f).checked = !!s[f]; else $(f).value = s[f];
  }
});

$('save').onclick = async () => {
  const next = {};
  for (const f of FIELDS) {
    if ($(f).type === 'checkbox') next[f] = $(f).checked;
    else if ($(f).type === 'number') next[f] = Number($(f).value) || DEFAULTS[f];
    else next[f] = $(f).value.trim();
  }
  await chrome.storage.local.set(next);
  const out = $('result');
  out.textContent = 'Testing…'; out.className = '';
  chrome.runtime.sendMessage({ type: 'check' }, (r) => {
    if (r && r.ok) { out.textContent = `Connected to NovaDM ${r.version}.`; out.className = 'ok'; }
    else { out.textContent = (r && r.error) || 'Not connected'; out.className = 'bad'; }
  });
};
