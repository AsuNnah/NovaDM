'use strict';
// NovaDM extension, background service worker: right-click "Download with NovaDM", the browser's
// downloads sent to NovaDM (optional), and videos/streams seen on pages (listed in the popup).
importScripts('lib.js');
const { DEFAULTS, shouldIntercept, classifyResponse, cookieHeader, addBody, apiUrl } = globalThis.NovaLib;

const settings = () => chrome.storage.local.get(DEFAULTS);

async function cookiesFor(url) {
  try { return cookieHeader(await chrome.cookies.getAll({ url })); } catch { return ''; }
}

/** Hand a link to NovaDM. Resolves with NovaDM's answer, or throws when it can't be reached. */
async function sendToNovaDM({ url, name, referer, pageUrl, size, start }) {
  const s = await settings();
  if (!s.key) throw new Error('Not connected: add NovaDM’s key in the extension options');
  const res = await fetch(apiUrl(s, 'downloads'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify(addBody({ url, name, referer, pageUrl, size, start, cookies: await cookiesFor(url) })),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `NovaDM answered ${res.status}`);
  return body;
}

function flash(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

// ---- right-click menu ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'link', title: 'Download link with NovaDM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'media', title: 'Download with NovaDM', contexts: ['video', 'audio', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'link' ? info.linkUrl : info.srcUrl;
  if (!/^(https?:\/\/|magnet:\?)/i.test(url || '')) return flash('?', '#e2574c');
  sendToNovaDM({ url, referer: info.pageUrl || (tab && tab.url) || '', pageUrl: info.pageUrl || '' })
    .then(() => flash('✓', '#35c28a'))
    .catch(() => flash('!', '#e2574c'));
});

// ---- the browser's own downloads ----
const fallback = new Set(); // links handed back to the browser because NovaDM couldn't take them

chrome.downloads.onCreated.addListener(async (item) => {
  if (fallback.has(item.url)) { fallback.delete(item.url); return; }
  const s = await settings();
  if (!shouldIntercept(item, s, chrome.runtime.id)) return;
  try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch { return; }
  try {
    await sendToNovaDM({ url: item.finalUrl || item.url, name: (item.filename || '').split(/[\\/]/).pop(), referer: item.referrer, pageUrl: item.referrer, size: item.fileSize || item.totalBytes });
    flash('✓', '#35c28a');
  } catch {
    // NovaDM isn't running or refused: let the browser download it after all.
    fallback.add(item.finalUrl || item.url);
    chrome.downloads.download({ url: item.finalUrl || item.url });
    flash('!', '#e2574c');
  }
});

// ---- videos and streams seen on pages ----
async function mediaOf(tabId) {
  const key = 'media:' + tabId;
  return (await chrome.storage.session.get(key))[key] || [];
}

async function setMedia(tabId, list) {
  await chrome.storage.session.set({ ['media:' + tabId]: list });
  chrome.action.setBadgeBackgroundColor({ color: '#5b7cfa', tabId });
  chrome.action.setBadgeText({ text: list.length ? String(list.length) : '', tabId });
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
  const kind = classifyResponse(d.url, h['content-type'], h['content-length']);
  if (!kind) return;
  mediaOf(d.tabId).then((list) => {
    if (list.some((m) => m.url === d.url) || list.length >= 50) return;
    list.push({ url: d.url, kind, size: Number(h['content-length']) || 0, pageUrl: d.initiator || '' });
    return setMedia(d.tabId, list);
  });
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) setMedia(tabId, []); });
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove('media:' + tabId));

// ---- popup / options ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'media') return reply({ list: await mediaOf(msg.tabId) });
    if (msg.type === 'send') {
      try { await sendToNovaDM(msg.item); reply({ ok: true }); } catch (e) { reply({ ok: false, error: e.message }); }
      return;
    }
    if (msg.type === 'check') {
      const s = { ...(await settings()), ...(msg.settings || {}) };
      try {
        const ping = await (await fetch(apiUrl(s, 'ping'))).json();
        const st = await fetch(apiUrl(s, 'status'), { headers: { Authorization: `Bearer ${s.key}` } });
        reply({ ok: st.ok, version: ping.version, error: st.ok ? '' : 'The key is not right' });
      } catch {
        reply({ ok: false, error: 'NovaDM is not running, or its connection for other apps is off (Settings → Other browsers and apps)' });
      }
    }
  })();
  return true;
});
