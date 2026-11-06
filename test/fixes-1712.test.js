'use strict';
// 1.7.12 bug fixes: private certificate exceptions, Mark of the Web on unpacked files, no sign-in headers kept.
const test = require('node:test');
const assert = require('node:assert');
const { Browser } = require('../src/main/browser');

test('closing the private window forgets only its certificate exceptions', () => {
  const b = { certSeen: new Map([['n|a.test', 'f1'], ['p|a.test', 'f2']]), certAllowed: new Set(['n|a.test|f1', 'p|a.test|f2', 'p|b.test|f3']) };
  Browser.prototype.forgetPrivateCerts.call(b);
  assert.deepStrictEqual([...b.certSeen.keys()], ['n|a.test']);
  assert.deepStrictEqual([...b.certAllowed], ['n|a.test|f1']);
});

test('files unpacked from a downloaded archive get the Mark of the Web, in every folder', { skip: process.platform !== 'win32' && 'needs NTFS (Windows CI)' }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { markTree, readMarkOfTheWeb } = require('../src/main/download/postprocess');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-motw-'));
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  for (const f of ['a.exe', 'sub/b.js', 'sub/deep/c.docx']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.strictEqual(markTree(dir, { url: 'https://dl.test/x.zip', referrer: 'https://dl.test/' }), 3);
  for (const f of ['a.exe', 'sub/b.js', 'sub/deep/c.docx']) assert.match(readMarkOfTheWeb(path.join(dir, f)), /ZoneId=3[\s\S]*HostUrl=https:\/\/dl\.test\/x\.zip/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a finished download is saved without its cookie and authorization headers; an unfinished one keeps them to resume', () => {
  const { headersToSave } = require('../src/main/download/manager');
  const headers = { Cookie: 's=1', authorization: 'Bearer x', referer: 'https://a.test/', 'user-agent': 'UA' };
  assert.deepStrictEqual(headersToSave({ state: 'done', headers }), { referer: 'https://a.test/', 'user-agent': 'UA' });
  assert.strictEqual(headersToSave({ state: 'paused', headers }), headers);
  assert.strictEqual(headersToSave({ state: 'done', headers: undefined }), undefined);
});

test('a finished joined video + audio download is saved without the tracks\' sign-in headers', () => {
  const { mergeSourceToSave } = require('../src/main/download/manager');
  const mergeSource = { tracks: [{ url: 'v', headers: { cookie: 'a', 'proxy-authorization': 'b', referer: 'r' } }, { url: 'a' }] };
  assert.deepStrictEqual(mergeSourceToSave({ state: 'done', mergeSource }).tracks.map((t) => t.headers), [{ referer: 'r' }, undefined]);
  assert.strictEqual(mergeSourceToSave({ state: 'running', mergeSource }), mergeSource);
  assert.strictEqual(mergeSourceToSave({ state: 'done' }), null);
});
