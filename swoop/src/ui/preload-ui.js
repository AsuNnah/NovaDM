'use strict';
// Bridge for Swoop's own UI pages (chrome bar, popovers, new tab). Exposes a minimal, safe API.
const { contextBridge, ipcRenderer } = require('electron');

// The toolbar gets the <browser-action-list> element for Chrome extension buttons.
if (/[\\/]ui[\\/]chrome\.html$/.test(decodeURIComponent(location.pathname))) {
  try { require('electron-chrome-extensions/browser-action').injectBrowserAction(); } catch (e) { console.error('extension buttons unavailable', e); }
}

contextBridge.exposeInMainWorld('swoop', {
  call: (method, args) => ipcRenderer.invoke('swoop:call', method, args),
  on: (name, cb) => {
    const listener = (_e, evName, data) => { if (evName === name) cb(data); };
    ipcRenderer.on('swoop:event', listener);
    return () => ipcRenderer.removeListener('swoop:event', listener);
  },
  onAny: (cb) => {
    const listener = (_e, evName, data) => cb(evName, data);
    ipcRenderer.on('swoop:event', listener);
    return () => ipcRenderer.removeListener('swoop:event', listener);
  },
});
