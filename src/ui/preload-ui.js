'use strict';
// Bridge for NovaDM's own UI pages (chrome bar, popovers, new tab). Exposes a minimal, safe API.
const { contextBridge, ipcRenderer } = require('electron');

// The private window's toolbar and panels: purple colourway (theme.css).
function markPrivate() { // the preload runs before <html> exists: tag it as soon as it does
  if (document.documentElement) return document.documentElement.classList.add('private');
  const o = new MutationObserver(() => { if (document.documentElement) { document.documentElement.classList.add('private'); o.disconnect(); } });
  o.observe(document, { childList: true });
}
if (new URLSearchParams(location.search).has('private')) markPrivate();

// The toolbar gets the <browser-action-list> element for Chrome extension buttons.
if (/[\\/]ui[\\/]chrome\.html$/.test(decodeURIComponent(location.pathname))) {
  try { require('electron-chrome-extensions/browser-action').injectBrowserAction(); } catch (e) { console.error('extension buttons unavailable', e); }
}

contextBridge.exposeInMainWorld('novadm', {
  call: (method, args) => ipcRenderer.invoke('novadm:call', method, args),
  on: (name, cb) => {
    const listener = (_e, evName, data) => { if (evName === name) cb(data); };
    ipcRenderer.on('novadm:event', listener);
    return () => ipcRenderer.removeListener('novadm:event', listener);
  },
  onAny: (cb) => {
    const listener = (_e, evName, data) => cb(evName, data);
    ipcRenderer.on('novadm:event', listener);
    return () => ipcRenderer.removeListener('novadm:event', listener);
  },
});
