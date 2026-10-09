'use strict';
// Injected into every page (isolated world). Finds media the network sniffer can't see on its own
// (<video>/<source>/<a> links), reports the page title and poster for thumbnails, detects DRM (EME),
// and shows a Download button when the pointer is over a <video>.
const { ipcRenderer, contextBridge } = require('electron');

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|wmv|flv|mpg|mpeg|3gp|ogv|mp3|m4a|aac|flac|wav|ogg|opus|wma|m3u8|mpd|ts)(\?|#|$)/i;
const DOC_EXT = /\.(pdf|zip|rar|7z|gz|exe|msi|apk|iso|docx?|xlsx?|pptx?|epub|torrent)(\?|#|$)/i;

const INTERNAL = location.protocol === 'file:' && /[\\/]ui[\\/]\w+\.html$/.test(location.pathname);

function abs(u) { try { return new URL(u, location.href).href; } catch { return ''; } }
function send(channel, payload) { try { ipcRenderer.send('novadm:tab', { ch: channel, payload }); } catch {} }

// NovaDM's own internal pages (new tab, etc.) get a tiny navigation + stats bridge.
if (INTERNAL) {
  try {
    contextBridge.exposeInMainWorld('novadmInternal', {
      navigate: (input) => ipcRenderer.send('novadm:tab', { ch: 'novadm:navigate', payload: { input } }),
      stats: () => ipcRenderer.invoke('novadm:internal-stats'),
      getSettings: () => ipcRenderer.invoke('novadm:internal-settings', 'get'),
      setSettings: (patch) => ipcRenderer.invoke('novadm:internal-settings', 'set', patch),
      chooseDownloadDir: () => ipcRenderer.invoke('novadm:internal-settings', 'chooseDir'),
      setProxyPassword: (pw) => ipcRenderer.invoke('novadm:internal-settings', 'proxyPassword', pw),
      settingsOp: (op, arg) => ipcRenderer.invoke('novadm:internal-settings', op, arg),
      // Downloads page: allowed actions are checked again in the main process.
      call: (method, args) => ipcRenderer.invoke('novadm:internal-call', method, args),
      on: (name, cb) => {
        const listener = (_e, n, data) => { if (n === name) cb(data); };
        ipcRenderer.on('novadm:internal-event', listener);
        return () => ipcRenderer.removeListener('novadm:internal-event', listener);
      },
    });
  } catch {}
}

// ---- page meta (title + best thumbnail) ------------------------------------------------------
function meta() {
  const pick = (sel, attr) => { const el = document.querySelector(sel); return el ? abs(el.getAttribute(attr)) : ''; };
  const thumb = pick('meta[property="og:image"]', 'content')
    || pick('meta[name="twitter:image"]', 'content')
    || pick('link[rel="image_src"]', 'href')
    || (document.querySelector('video[poster]') ? abs(document.querySelector('video[poster]').getAttribute('poster')) : '');
  return { url: location.href, title: document.title || '', thumbnail: thumb };
}

// ---- DOM media scan --------------------------------------------------------------------------
function scan() {
  const found = [];
  const add = (url, kind, name) => { const a = abs(url); if (a && /^https?:/.test(a)) found.push({ url: a, kind, name: name || '' }); };
  document.querySelectorAll('video, audio').forEach((el) => {
    const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
    if (el.src && !el.src.startsWith('blob:') && !el.src.startsWith('mediasource:')) add(el.src, kind);
    el.querySelectorAll('source').forEach((s) => { if (s.src) add(s.src, s.type && s.type.startsWith('audio') ? 'audio' : kind); });
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    if (MEDIA_EXT.test(href)) add(href, 'media', (a.textContent || '').trim().slice(0, 80));
    else if (DOC_EXT.test(href)) add(href, 'file', (a.textContent || '').trim().slice(0, 80));
  });
  if (found.length) send('novadm:dom-media', found);
}

// Pages that keep changing (feeds, players) would re-scan constantly: at most one scan every 2 s,
// run when the page is idle so it never competes with the page's own work.
let scanTimer = null;
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 0));
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => idle(() => { scanTimer = null; scan(); }), 2000);
}

// ---- de-AMP and reader view -------------------------------------------------------------------
// An AMP page names its real (canonical) page; NovaDM opens that one instead (Settings → Privacy).
function checkAmp() {
  const html = document.documentElement;
  if (!html || !(html.hasAttribute('amp') || html.hasAttribute('⚡'))) return;
  const link = document.querySelector('link[rel="canonical"][href]');
  const canonical = link ? abs(link.getAttribute('href')) : '';
  if (/^https?:/.test(canonical) && canonical.split('#')[0] !== location.href.split('#')[0]) send('novadm:amp', { canonical, from: location.href });
}

// Enough article text for reader view (same idea as Firefox's "probably readerable" check).
function checkReadable() {
  if (INTERNAL || !/^https?:/.test(location.protocol)) return;
  let score = 0;
  const nodes = document.querySelectorAll('p, pre, article');
  for (let i = 0; i < nodes.length && i < 400; i++) {
    const n = nodes[i];
    if (!n.offsetParent && n.offsetHeight === 0) continue; // hidden
    const m = `${n.className} ${n.id}`;
    if (/comment|footer|sidebar|sponsor|promo|share|related/i.test(m) && !/article|content|main|body|post/i.test(m)) continue;
    const len = (n.textContent || '').trim().length;
    if (len < 140) continue;
    score += Math.sqrt(len - 140);
    if (score > 20) break;
  }
  send('novadm:readable', { ok: score > 20, url: location.href });
}

// ---- on-video download button ----------------------------------------------------------------
let btn = null;
function ensureButton() {
  if (btn) return btn;
  btn = document.createElement('div');
  btn.textContent = 'Download';
  btn.setAttribute('aria-hidden', 'true');
  Object.assign(btn.style, {
    position: 'fixed', zIndex: 2147483647, padding: '6px 12px', borderRadius: '999px',
    background: '#3b6ef5', color: '#fff', font: '500 13px/1 system-ui, sans-serif',
    cursor: 'pointer', display: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.35)', userSelect: 'none',
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    send('novadm:download-video', { pageUrl: location.href });
  });
  (document.body || document.documentElement).appendChild(btn);
  return btn;
}
function positionFor(video) {
  if (!video || video.readyState === 0 || (video.clientWidth < 160 && video.clientHeight < 120)) return hideButton();
  const r = video.getBoundingClientRect();
  if (r.width < 160 || r.height < 100 || r.bottom < 0 || r.top > innerHeight) return hideButton();
  const b = ensureButton();
  b.style.display = 'block';
  b.style.top = Math.max(8, r.top + 10) + 'px';
  b.style.left = Math.min(innerWidth - 110, r.right - 110) + 'px';
}
function hideButton() { if (btn) btn.style.display = 'none'; }

function onPointerMove(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const video = el && (el.closest ? el.closest('video') : null);
  if (video) positionFor(video); else if (btn && e.target !== btn) hideButton();
}

// Hook EME in the page's main world (best-effort; a strict CSP may block this inline script).
function injectEmeHook() {
  if (INTERNAL) return;
  try {
    const code = `(function(){try{if(navigator.__novadmEme)return;navigator.__novadmEme=1;` +
      `var o=navigator.requestMediaKeySystemAccess;if(!o)return;` +
      `navigator.requestMediaKeySystemAccess=function(ks,cfg){` +
      `try{if(/widevine|playready|primetime|fairplay/i.test(ks))window.postMessage({__novadmEme:1,keySystem:ks},'*');}catch(e){}` +
      `return o.apply(this,arguments);};}catch(e){}})();`;
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch {}
}

// ---- genuine link clicks (for the pop-up guard) -----------------------------------------------
// Only clicks the user really made (isTrusted) on a real link are reported. Scripts can't fake
// isTrusted, so window.open() from an ad script never matches one of these.
function onUserClick(e) {
  if (!e.isTrusted || (e.type === 'auxclick' && e.button !== 1)) return;
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a || !/^https?:/i.test(a.href)) return;
  send('novadm:link-click', { href: a.href, mods: !!(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) });
}
window.addEventListener('click', onUserClick, true);
window.addEventListener('auxclick', onUserClick, true);

// ---- boot ------------------------------------------------------------------------------------
function boot() {
  injectEmeHook();
  send('novadm:page-meta', meta());
  if (!INTERNAL) checkAmp();
  idle(scan);
  if (!INTERNAL) {
    if (document.readyState === 'complete') idle(checkReadable);
    else window.addEventListener('load', () => idle(checkReadable), { once: true });
  }
  try {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
  } catch {}
  document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  window.addEventListener('scroll', hideButton, { passive: true });
  // Title can change after load (SPAs).
  let lastTitle = document.title;
  setInterval(() => { if (document.title !== lastTitle) { lastTitle = document.title; send('novadm:page-meta', meta()); } }, 2000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

// EME (DRM) detection runs in the page's main world; relay its postMessage to the host.
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__novadmEme) send('novadm:eme', { keySystem: String(e.data.keySystem || '') });
});
