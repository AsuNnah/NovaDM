'use strict';
// Preload of the sandboxed page that runs one site extension (see site-ext.js). The page gets only
// this bridge: run the extension, let it ask NovaDM to fetch from its own sites, report the result.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__novadmHost', {
  onRun: (cb) => ipcRenderer.once('siteext:run', (_e, job) => cb(job)),
  fetchText: (url, opts) => ipcRenderer.invoke('siteext:fetch', String(url), opts || {}),
  done: (items) => ipcRenderer.send('siteext:done', { items }),
  fail: (message) => ipcRenderer.send('siteext:done', { error: String(message) }),
});
