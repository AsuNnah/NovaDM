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
