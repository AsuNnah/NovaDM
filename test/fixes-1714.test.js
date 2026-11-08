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
  importData({ app: 'NovaDM', format: 1, settings: { ...data, downloadDir: 'C:\\Users' } }, { settings, downloads: { records: new Map() } });
  assert.deepStrictEqual(settings.patch, { theme: 'dark' }); // nor a download folder that would widen the save-path check
});

test('a backup leaves out every sign-in header, proxy sign-ins included', () => {
  const headers = { Cookie: 'a', Authorization: 'b', 'Proxy-Authorization': 'c', referer: 'r' };
  const rec = { kind: 'http', headers, state: 'done', mergeSource: { tracks: [{ headers }] } };
  const out = exportData({ settings: { data: {} }, downloads: { records: new Map([['1', rec]]) }, version: 't' });
  assert.deepStrictEqual(out.downloads[0].headers, { referer: 'r' });
  assert.deepStrictEqual(out.downloads[0].mergeSource.tracks[0].headers, { referer: 'r' });
  const back = fakeManager().importRecord({ ...rec, name: 'a', sources: ['https://a.test/a'], savePath: '' }); // and a hand-made file's are dropped
  assert.deepStrictEqual([back.headers, back.mergeSource.tracks[0].headers], [{ referer: 'r' }, { referer: 'r' }]);
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

test('what yt-dlp found on private pages is forgotten when the private window closes; normal pages keep theirs', async () => {
  let asked = 0;
  const tabs = { p: { id: 1, incognito: true, url: 'https://v.test/p' }, n: { id: 2, incognito: false, url: 'https://v.test/n' } };
  let active = tabs.p;
  const ses = { cookies: { get: async () => [] } };
  const spec = { kind: 'http', url: 'https://v.test/f.mp4' };
  const requested = [];
  const { handlers } = loadIpc({ managers: {
    browser: { activeTab: () => active, incognitoSession: ses, normalSession: ses },
    ytdlp: { find: async () => { asked++; return { title: 't', duration: 1, choices: [{ label: 'best', spec }] }; } },
    addFlow: { request: (s) => { requested.push(s); return { ok: true }; } },
  } });
  const { forgetPrivate } = require('../src/main/ipc');
  await handlers['media.ytdlpFind']();
  active = tabs.n; await handlers['media.ytdlpFind']();
  active = tabs.p; await handlers['media.ytdlpFind']();
  assert.strictEqual(asked, 2); // the private page's answer was kept while its window was open
  forgetPrivate();
  assert.deepStrictEqual(handlers['media.ytdlpDownload']({ index: 0 }), { ok: false }); // its choices are gone
  await handlers['media.ytdlpFind']();
  assert.strictEqual(asked, 3); // asked again
  active = tabs.n; await handlers['media.ytdlpFind']();
  assert.strictEqual(asked, 3); // the normal page's answer stays
});

test('the local API key is kept encrypted, an old plain key moves over, and the Settings page never gets it from settings', async () => {
  const Module = require('module');
  const proxyId = require.resolve('../src/main/proxy');
  const apiId = require.resolve('../src/main/api');
  const savedProxy = require.cache[proxyId];
  const fake = new Module(proxyId); fake.loaded = true;
  fake.exports = { encryptPassword: async (k) => 'enc:' + k, decryptPassword: async (e) => e.slice(4) };
  require.cache[proxyId] = fake; delete require.cache[apiId];
  try {
    const { LocalApi } = require('../src/main/api');
    const data = { apiKey: 'old-plain' };
    const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
    const api = new LocalApi({ settings });
    assert.strictEqual(api.key(), ''); // nothing accepted before the key is loaded
    assert.strictEqual(await api.loadKey(), 'old-plain');
    assert.deepStrictEqual(data, { apiKey: '', apiKeyEnc: 'enc:old-plain' });
    const again = new LocalApi({ settings });
    assert.strictEqual(await again.loadKey(), 'old-plain'); // read back from the encrypted copy
    const k = await again.newKey();
    assert.strictEqual(data.apiKeyEnc, 'enc:' + k);
    assert.strictEqual(again.authorized({ headers: { authorization: 'Bearer ' + k } }), true);
    assert.strictEqual(new LocalApi({ settings }).authorized({ headers: {} }), false); // empty key, empty answer
    const unreadable = { apiKeyEnc: 'xx' }; // decrypts to '' (another Windows account): kept, and nothing accepted
    const locked = new LocalApi({ settings: { get: (k) => unreadable[k], set: (p) => Object.assign(unreadable, p) } });
    assert.strictEqual(await locked.loadKey(), '');
    assert.deepStrictEqual(unreadable, { apiKeyEnc: 'xx' });
  } finally { if (savedProxy) require.cache[proxyId] = savedProxy; else delete require.cache[proxyId]; delete require.cache[apiId]; }
  const { Settings } = require('../src/main/settings');
  const all = Settings.prototype.all.call({ data: { apiKey: 'a', apiKeyEnc: 'b', proxyPassEnc: 'c', theme: 'dark' } });
  assert.strictEqual('apiKey' in all || 'apiKeyEnc' in all || 'proxyPassEnc' in all, false);
});

test('only NovaDM\'s own UI files may call in, and internal pages only the methods on their list', async () => {
  const { pathToFileURL } = require('url');
  const { handlers, listeners } = loadIpc({ managers: { settings: { all: () => ({ ok: 1 }) } } });
  const { fromUi, INTERNAL } = require('../src/main/ipc');
  const ui = pathToFileURL(path.join(__dirname, '..', 'src', 'ui', 'panel.html')).href;
  const frame = (url) => ({ senderFrame: { url }, sender: { id: 1 } });
  for (const bad of ['https://evil.test/', 'file:///C:/Users/x/Downloads/page.html', ui.replace('/ui/', '/ui-other/'), '', 'novadm://settings']) {
    assert.strictEqual(fromUi(frame(bad)), false, bad);
    await assert.rejects(listeners['novadm:call'](frame(bad), 'settings.get'), /not allowed/);
  }
  assert.strictEqual(fromUi(frame(ui.toUpperCase().replace('FILE:', 'file:'))), true); // Windows paths: any case
  assert.deepStrictEqual(await listeners['novadm:call'](frame(ui), 'settings.get'), { ok: 1 });
  await assert.rejects(listeners['novadm:call'](frame(ui), 'no.such'), /Unknown method/);
  for (const m of ['downloads.list', 'cert.proceed', 'about.check']) assert.ok(INTERNAL.test(m), m);
  for (const m of ['settings.get', 'tabs.new', 'window.close', 'shields.setGlobal', 'downloads.list;x', 'downloads.']) assert.ok(!INTERNAL.test(m), m);
  assert.ok(handlers['settings.get']);
});

test('settings writes keep only known settings and keep connection counts in range', () => {
  const Module = require('module');
  const id = require.resolve('electron'); const sid = require.resolve('../src/main/settings');
  const saved = require.cache[id];
  const m = new Module(id); m.loaded = true; m.exports = { app: { getPath: () => os.tmpdir() } };
  require.cache[id] = m; delete require.cache[sid];
  const { Settings } = require('../src/main/settings');
  if (saved) require.cache[id] = saved; else delete require.cache[id];
  const s = { data: { connections: 8, maxActive: 3, theme: 'system' }, store: { save() {} }, emit() {} };
  const changed = Settings.prototype.set.call(s, { theme: 'dark', __proto__x: 1, notASetting: 'x', connections: 99, maxActive: 0 });
  assert.deepStrictEqual(Object.keys(changed).sort(), ['connections', 'maxActive', 'theme']);
  assert.strictEqual('notASetting' in s.data, false);
  assert.strictEqual(s.data.connections, 32); assert.strictEqual(s.data.maxActive, 1);
});

test('passwords are encrypted asynchronously, refused when Windows can\'t protect them, and readable from the cache once primed', async () => {
  const Module = require('module');
  const id = require.resolve('electron'); const proxyId = require.resolve('../src/main/proxy');
  const saved = require.cache[id];
  let available = true;
  const m = new Module(id); m.loaded = true;
  m.exports = { safeStorage: {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (t) => Buffer.from('x' + t),
    decryptStringAsync: async (b) => ({ result: b.toString().slice(1) }),
  } };
  require.cache[id] = m; delete require.cache[proxyId];
  try {
    const proxy = require('../src/main/proxy');
    const enc = await proxy.encryptPassword('pw');
    assert.notStrictEqual(enc, 'pw');
    assert.strictEqual(await proxy.decryptPassword(enc), 'pw');
    assert.strictEqual(proxy.decryptedPassword(enc), ''); // not primed yet
    await proxy.primeCredentials({ get: (k) => (k === 'proxyPassEnc' ? enc : k === 'siteSettings' ? [] : '') });
    assert.strictEqual(proxy.decryptedPassword(enc), 'pw');
    available = false;
    await assert.rejects(proxy.encryptPassword('pw'), /could not protect/);
  } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; delete require.cache[proxyId]; }
});
