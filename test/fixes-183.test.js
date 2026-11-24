'use strict';
// 1.8.3 "Close the security gaps" (audit 2026-11-24).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

test('AU-17: the problem report hides My filters and the address of a crashed private tab', () => {
  const diag = require('../src/main/diagnostics');
  assert.ok(!diag.settingValue('myFilters', '||my-clinic.example^').includes('clinic'));
  const app = new EventEmitter();
  diag.install(app);
  const wc = (persistent, url) => ({ getURL: () => url, session: { isPersistent: () => persistent } });
  app.emit('render-process-gone', {}, wc(false, 'https://secret-private.example/'), { reason: 'crashed', exitCode: 1 });
  app.emit('render-process-gone', {}, wc(true, 'https://normal.example/'), { reason: 'crashed', exitCode: 1 });
  const text = diag.recent().join('\n');
  assert.ok(!text.includes('secret-private'), text);
  assert.ok(text.includes('normal.example'), 'a normal tab still says which page crashed');
});

test('AU-18: clearing history also clears Recently closed in that time range', () => {
  const { Browser } = require('../src/main/browser');
  const b = { closed: [{ id: 1, url: 'https://old.test/', t: Date.now() - 2 * 3600e3 }, { id: 2, url: 'https://new.test/', t: Date.now() - 60e3 }] };
  Browser.prototype.forgetClosed.call(b, 3600e3);
  assert.deepStrictEqual(b.closed.map((c) => c.id), [1], 'last hour cleared, older kept');
  Browser.prototype.forgetClosed.call(b, Infinity);
  assert.deepStrictEqual(b.closed, []);
});

test('AU-23: reserved Windows names are caught before the first dot, with CONIN$/CONOUT$ and superscript digits', () => {
  const { sanitizeFilename } = require('../src/main/util');
  for (const n of ['aux.tar.gz', 'con.part1.rar', 'nul.x.mp4', 'CONIN$', 'conout$.txt', 'com¹.txt', 'LPT³', 'aux .txt']) {
    assert.ok(sanitizeFilename(n).startsWith('_'), `${n} -> ${sanitizeFilename(n)}`);
  }
  for (const n of ['auxiliary.txt', 'console.log', 'com10.txt', 'report.aux']) assert.strictEqual(sanitizeFilename(n), n);
});

test('AU-24: a command shell or script host is refused as the after-download program', async () => {
  const { runProgram } = require('../src/main/hooks');
  let spawned = 0;
  const spawnFn = () => { spawned++; const e = new EventEmitter(); e.unref = () => {}; setImmediate(() => e.emit('spawn')); return e; };
  for (const p of ['C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'C:\\Program Files\\PowerShell\\7\\PWSH.EXE', 'wscript.exe', 'cscript.exe', 'mshta.exe']) {
    const r = await runProgram(p, '{file}', { savePath: 'C:\\a&calc.exe' }, spawnFn);
    assert.strictEqual(r.ok, false, p);
  }
  assert.strictEqual(spawned, 0);
});

test('AU-06: a site extension’s fetch is checked on every redirect, not just the first address', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { SiteExtensions } = require('../src/main/site-ext');
  // A stand-in for net.fetchText: /r redirects to another site, and the guard (if any) sees each hop.
  const fetchText = async (url, opts = {}) => {
    if (!url.endsWith('/r')) return { status: 200, url, text: 'ok' };
    const next = 'https://mail.example/inbox';
    if (opts.guard) await opts.guard(next);
    return { status: 200, url: next, text: 'the user’s mail' };
  };
  const se = new SiteExtensions({ settings: { get: () => undefined, set() {} }, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-se-')), fetchText, createSandbox: () => ({}) });
  se.runs.set(5, { ext: { matches: ['https://a.example/*'] }, session: null });
  assert.strictEqual((await se.fetchFor(5, 'https://a.example/api')).text, 'ok');
  await assert.rejects(se.fetchFor(5, 'https://a.example/r'), /may not read mail\.example/);
});

test('AU-07: an app link is asked and remembered per link type; risky types are refused without asking', () => {
  const { Browser } = require('../src/main/browser');
  const store = { sitePermissions: { 'https://meet.example': { 'openExternal:zoommtg': 'granted', openExternal: 'granted' } } };
  const asked = [];
  const b = { settings: { get: (k) => store[k], set: (p) => Object.assign(store, p) }, privatePermissions: {}, emit: (ev, info) => { if (ev === 'permission-ask') asked.push(info); } };
  b.getStoredPermission = Browser.prototype.getStoredPermission;
  const tab = { id: 1, url: 'https://meet.example/room', incognito: false };
  const ask = (url) => { let r; Browser.prototype.handlePermission.call(b, tab, 'openExternal', { externalURL: url, requestingUrl: tab.url }, (v) => { r = v; }); return r; };
  assert.strictEqual(ask('zoommtg://zoom.us/join?x=1'), true, 'the type that was allowed');
  assert.strictEqual(ask('ms-msdt:/id PCWDiagnostic'), false, 'risky: refused');
  assert.strictEqual(ask('SEARCH-MS:query=x&crumb=location:\\\\evil\\share'), false);
  assert.strictEqual(asked.length, 0, 'risky types are never offered');
  assert.strictEqual(ask('msteams:/l/meetup'), undefined, 'another type is asked, an old blanket allow no longer counts');
  assert.deepStrictEqual([asked[0].permission, asked[0].scheme], ['openExternal:msteams', 'msteams']);
});

test('AU-08: a backup brings preferences, protections only when stricter, and never routing, folders or permissions', () => {
  const { importData } = require('../src/main/backup');
  const cur = { markOfTheWeb: true, phishingCheck: true, clearHistoryOnExit: false, scanDownloads: 'programs', securityLevel: 'safer', popupMode: 'ask', skipEditor: false };
  let patch = null;
  const settings = { get: (k) => cur[k], set: (p) => { patch = p; return p; } };
  importData({ app: 'NovaDM', format: 1, settings: {
    theme: 'dark', accent: 'teal', myFilters: '||ads.example^', searchEngine: 'brave',
    categoryRules: [{ by: 'type', value: 'zip', category: 'compressed', folder: 'C:\\Users\\Public\\Startup' }],
    proxyMode: 'fixed', proxyServer: 'evil.example:8080', proxyPac: 'http://evil.example/p.pac', secureDns: 'custom', secureDnsCustom: 'https://evil.example/dns',
    sitePermissions: { 'https://evil.example': { media: 'granted' } }, adblockWhitelist: ['evil.example'], popupAllow: ['evil.example'],
    markOfTheWeb: false, phishingCheck: false, scanDownloads: 'off', securityLevel: 'standard', skipEditor: true, // looser: ignored
    clearHistoryOnExit: true, popupMode: 'block', // stricter: applied
    apiEnabled: true, magnetHandler: true, startWithWindows: true, torrentPort: 1, hardeningOff: ['evil.example'],
  } }, { settings, downloads: { records: new Map() } });
  assert.deepStrictEqual(patch, {
    theme: 'dark', accent: 'teal', myFilters: '||ads.example^', searchEngine: 'brave',
    categoryRules: [{ by: 'type', value: 'zip', category: 'compressed' }],
    clearHistoryOnExit: true, popupMode: 'block',
  });
});

test('AU-12: Guard switches in a private window stay in memory, for private tabs only', () => {
  const store = {}; let writes = 0;
  const settings = { get: (k) => store[k], set: (p) => { writes++; Object.assign(store, p); } };
  const url = 'https://private-only.example/page';
  const hardening = require('../src/main/hardening');
  const { PopupGuard } = require('../src/main/popup');
  const { AdBlocker } = require('../src/main/adblock');
  const privateSites = require('../src/main/private-sites');
  const ab = { settings, emit() {} };

  AdBlocker.prototype.setSiteEnabled.call(ab, url, false, true);
  hardening.toggleSite(settings, url, true);
  const popup = new PopupGuard(settings);
  popup.blockSite(url, true, true);
  assert.strictEqual(writes, 0, 'nothing is written to settings');
  assert.strictEqual(AdBlocker.prototype.isWhitelisted.call(ab, url, true), true, 'Guard off in private tabs');
  assert.strictEqual(AdBlocker.prototype.isWhitelisted.call(ab, url, false), false, 'normal tabs keep Guard on');
  assert.strictEqual(hardening.protectionFor(settings, url, true), null);
  assert.ok(hardening.protectionFor(settings, url, false));
  assert.strictEqual(popup.siteBlocked(url, true), true);
  assert.strictEqual(popup.siteBlocked(url, false), false);

  privateSites.clear(); // the private window closed
  assert.strictEqual(AdBlocker.prototype.isWhitelisted.call(ab, url, true), false);
  assert.ok(hardening.protectionFor(settings, url, true));
});

test('AU-09: a torrent folder gets the Mark of the Web on every file inside, not just the folder', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const post = require('../src/main/download/postprocess');
  const { DownloadManager } = require('../src/main/download/manager');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-motw-'));
  fs.mkdirSync(path.join(dir, 'Pack')); fs.writeFileSync(path.join(dir, 'Pack', 'setup.exe'), 'x'); fs.writeFileSync(path.join(dir, 'one.iso'), 'x');
  const calls = [];
  const real = { tree: post.markTree, file: post.markOfTheWeb };
  post.markTree = (p) => { calls.push(['tree', path.basename(p)]); return 1; };
  post.markOfTheWeb = (p) => { calls.push(['file', path.basename(p)]); return true; };
  try {
    const m = { optimizeVideo: async () => {}, motw: () => ({ url: 'magnet:' }), settings: { get: () => false } };
    await DownloadManager.prototype.postProcess.call(m, { kind: 'torrent', savePath: path.join(dir, 'Pack') });
    await DownloadManager.prototype.postProcess.call(m, { kind: 'torrent', savePath: path.join(dir, 'one.iso') });
  } finally { post.markTree = real.tree; post.markOfTheWeb = real.file; }
  assert.deepStrictEqual(calls, [['tree', 'Pack'], ['file', 'one.iso']]);
});

test('AU-11: a session that did not finish closing (Windows shutdown) is noticed at the next start', () => {
  const { startSession, endSession } = require('../src/main/exit-marker');
  const store = {};
  const settings = { get: (k) => store[k], set: (p) => Object.assign(store, p), flush() {} };
  assert.strictEqual(startSession(settings), false, 'first start: nothing missed');
  assert.strictEqual(startSession(settings), true, 'started again without a normal quit: the clear-on-exit steps run now');
  endSession(settings);
  assert.strictEqual(startSession(settings), false, 'after a normal quit: nothing missed');
});

test('AU-25: in a long session the ad-block lists are rebuilt once they are older than the refresh interval', () => {
  const { AdBlocker } = require('../src/main/adblock');
  let refreshed = 0;
  const day = 24 * 3600 * 1000;
  const ab = { ready: true, settings: { data: { adblockUpdatedAt: Date.now() - 1 * day } }, refresh() { refreshed++; } };
  AdBlocker.prototype.refreshIfStale.call(ab);
  assert.strictEqual(refreshed, 0, 'one day old: kept');
  ab.settings.data.adblockUpdatedAt = Date.now() - 5 * day;
  AdBlocker.prototype.refreshIfStale.call(ab);
  assert.strictEqual(refreshed, 1, 'five days old: rebuilt');
});
