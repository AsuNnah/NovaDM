'use strict';
// 1.7.14: findings of the core and IPC audit (backup import safety, failed saves reported, trust checks).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { DownloadManager } = require('../src/main/download/manager');
const { exportData, importData } = require('../src/main/backup');

const DL = path.join(os.tmpdir(), 'novadm-dl');
function fakeManager() {
  const records = new Map();
  const settings = { data: {}, get: (k) => ({ downloadDir: DL, categoryFolders: false })[k] };
  const m = { records, settings, queueIds: () => ['main'], persist() {}, emitList() {} };
  m.categoryDir = DownloadManager.prototype.categoryDir.bind(m);
  m.importRecord = DownloadManager.prototype.importRecord.bind(m);
  return m;
}

test('an imported download keeps its save path only inside the download folder', () => {
  const m = fakeManager();
  const outside = m.importRecord({ kind: 'http', name: 'holiday.mp4', state: 'paused', sources: ['https://a.test/x'], savePath: path.join(os.homedir(), 'Documents', 'thesis.docx') });
  assert.strictEqual(outside.savePath, path.join(DL, 'holiday.mp4'));
  const sneaky = m.importRecord({ kind: 'http', name: 'b.zip', state: 'done', sources: ['https://a.test/b'], savePath: path.join(DL, '..', 'b.zip') });
  assert.strictEqual(sneaky.savePath, path.join(DL, 'b.zip'));
  const inside = path.join(DL, 'Videos', 'c.mp4');
  assert.strictEqual(m.importRecord({ kind: 'http', name: 'c.mp4', state: 'done', sources: ['https://a.test/c'], savePath: inside }).savePath, inside);
  assert.strictEqual(m.importRecord({ kind: 'http', name: '..\\..\\evil.exe', state: 'paused', sources: ['https://a.test/e'], savePath: DL }).savePath.startsWith(DL + path.sep), true);
});

test('a backup carries no program to run after downloads and no webhook, in either direction', () => {
  const data = { afterProgram: 'C:\\x.exe', afterArgs: '"%f"', webhookUrl: 'https://hook.test/', theme: 'dark' };
  const settings = { data, set(p) { this.patch = p; return p; } };
  const out = exportData({ settings, downloads: { records: new Map() }, version: 't' });
  assert.deepStrictEqual(Object.keys(out.settings), ['theme']);
  importData({ app: 'NovaDM', format: 1, settings: data }, { settings, downloads: { records: new Map() } });
  assert.deepStrictEqual(settings.patch, { theme: 'dark' });
});

test('a backup leaves out every sign-in header, proxy sign-ins included', () => {
  const headers = { Cookie: 'a', Authorization: 'b', 'Proxy-Authorization': 'c', referer: 'r' };
  const rec = { kind: 'http', headers, state: 'done', mergeSource: { tracks: [{ headers }] } };
  const out = exportData({ settings: { data: {} }, downloads: { records: new Map([['1', rec]]) }, version: 't' });
  assert.deepStrictEqual(out.downloads[0].headers, { referer: 'r' });
  assert.deepStrictEqual(out.downloads[0].mergeSource.tracks[0].headers, { referer: 'r' });
});

// ipc.js with a stand-in for Electron: its handlers, and the IPC listeners it registered.
function loadIpc({ dialog = {}, managers = {} } = {}) {
  const Module = require('module');
  const listeners = {};
  // Anything not given is a function that does nothing (Electron modules other files load call some at load time).
  const stub = (given = {}) => new Proxy(function () {}, { get: (_t, k) => (k in given ? given[k] : k === 'then' ? undefined : stub()), apply: () => undefined });
  const fake = stub({
    app: stub({ isPackaged: false, isReady: () => false, whenReady: () => new Promise(() => {}), getVersion: () => '0.0.0', getAppPath: () => '/app', getPath: () => os.tmpdir() }),
    ipcMain: stub({ handle: (ch, fn) => { listeners[ch] = fn; } }), dialog: stub(dialog),
  });
  const id = require.resolve('electron');
  const saved = require.cache[id];
  const m = new Module(id); m.exports = fake; m.loaded = true; require.cache[id] = m;
  try {
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'main')) && !/manager|backup/.test(k)) delete require.cache[k];
    const { registerIpc } = require('../src/main/ipc');
    const handlers = registerIpc({ getManagers: () => managers, setPanel() {}, sendUI() {}, sendMediaState() {} });
    return { handlers, listeners };
  } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
}

test('a backup, problem report or torrent file that cannot be written or read is reported, not lost silently', async () => {
  const nowhere = path.join(os.tmpdir(), 'novadm-no-such-dir', 'sub', 'x.json');
  const shown = [];
  const { handlers } = loadIpc({
    dialog: { showSaveDialog: async () => ({ filePath: nowhere }), showOpenDialog: async () => ({ filePaths: [nowhere] }), showMessageBox: async (_w, o) => { shown.push(o.message); return {}; } },
    managers: { win: {}, settings: { data: {}, get: () => '' }, downloads: { records: new Map() }, addFlow: { requestTorrentFile() {} } },
  });
  const exp = await handlers['downloads.export']();
  assert.strictEqual(exp.ok, false); assert.match(exp.error, /not saved/);
  const tor = await handlers['downloads.openTorrent']();
  assert.strictEqual(tor.ok, false); assert.match(tor.error, /torrent file/);
  handlers['diagnostics.report'] = async () => 'report';
  assert.strictEqual((await handlers['diagnostics.save']()).ok, false);
  assert.deepStrictEqual(shown, ['The report was not saved']);
});
