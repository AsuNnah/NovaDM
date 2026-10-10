'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../src/main/redact');
const { siteFor, searchUrl } = require('../src/main/site-search');

const who = { user: 'jdoe', pc: 'DESKTOP-7Q2X', home: 'C:\\Users\\jdoe' };

test('redact: nothing personal is left', () => {
  const text = [
    'saving to C:\\Users\\jdoe\\Downloads\\bank-statement.pdf',
    'other profile c:/users/Someone.Else/AppData/x',
    'GET https://mail.example.com/inbox/12345?token=abc#msg failed',
    'login https://me:hunter2@example.com/admin',
    'magnet:?xt=urn:btih:ABCDEF&dn=private-file',
    'file:///D:/Private/notes.html',
    'mail jane.doe+tag@example.org',
    'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'host DESKTOP-7Q2X user jdoe; jdoes stays',
    'at run (D:\\Code Projects\\NovaDM\\src\\main\\download\\http.js:120:7)',
    'wrote D:\\Private stuff\\taxes\\2026\\return.xlsx',
  ].join('\n');
  const out = redact(text, { ...who, appPath: 'D:\\Code Projects\\NovaDM' });
  assert.match(out, /\[app\]\\src\\main\\download\\http\.js:120/); // NovaDM's own code stays readable
  assert.match(out, /D:\\Private stuff\\…\\\[file\]\.xlsx/); // first folder and file type only
  assert.ok(!/taxes|return\.xlsx/.test(out));
  for (const secret of ['jdoe\\', 'bank-statement', 'Someone.Else', 'inbox', 'token=abc', 'hunter2', 'admin', 'private-file', 'Private/notes', 'jane.doe', 'eyJhbGci', 'DESKTOP-7Q2X', ' jdoe;']) {
    assert.ok(!out.includes(secret), `still contains ${secret}:\n${out}`);
  }
  assert.match(out, /https:\/\/mail\.example\.com\/…/); // the site stays: needed to find site bugs
  assert.match(out, /%USERPROFILE%\\Downloads/);
  assert.match(out, /jdoes stays/); // only the whole name is replaced
});

test('report settings: personal values only say whether they are set', () => {
  const { settingValue } = require('../src/main/diagnostics');
  assert.strictEqual(settingValue('theme', 'dark'), 'dark');
  assert.strictEqual(settingValue('adblock', true), 'true');
  assert.strictEqual(settingValue('downloadDir', 'C:\\Users\\jdoe\\Downloads'), '[set]');
  assert.strictEqual(settingValue('homepage', ''), '[empty]');
  assert.strictEqual(settingValue('proxyServer', 'myproxy:8080'), '[set]');
  assert.strictEqual(settingValue('hardeningOff', ['bank.example']), '1 item(s)');
  assert.strictEqual(settingValue('sitePermissions', { a: 1, b: 2 }), '2 item(s)');
});

test('tab to search: site names', () => {
  assert.strictEqual(siteFor('youtube').name, 'YouTube');
  assert.strictEqual(siteFor('you').name, 'YouTube');
  assert.strictEqual(siteFor('yt').name, 'YouTube');
  assert.strictEqual(siteFor('www.youtube.com').name, 'YouTube');
  assert.strictEqual(siteFor('https://en.wikipedia.org/').name, 'Wikipedia');
  assert.strictEqual(siteFor('goo').name, 'Google');
  assert.strictEqual(siteFor('go'), null); // too short to guess
  assert.strictEqual(siteFor('y'), null);
  assert.strictEqual(siteFor('youtube cats'), null); // already a search
  assert.strictEqual(siteFor('example.com'), null);
  assert.strictEqual(searchUrl(siteFor('yt'), 'lo-fi & rain'), 'https://www.youtube.com/results?search_query=lo-fi%20%26%20rain');
});
