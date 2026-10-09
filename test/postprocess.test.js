'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScanOutput, wantsScan, markOfTheWeb, readMarkOfTheWeb } = require('../src/main/download/postprocess');

test('Defender output decides the result, not its exit code', () => {
  assert.deepEqual(parseScanOutput('Scan starting...\nScan finished.\nScanning C:\\x\\a.zip found no threats.\n'), { result: 'clean', detail: '' });
  const threat = parseScanOutput('Scanning C:\\x\\eicar.com found 1 threats.\n<===========================LIST OF DETECTED THREATS==========================>\n----------------------------- Threat information ------------------------------\nThreat                  : Virus:DOS/EICAR_Test_File\n');
  assert.equal(threat.result, 'threat');
  assert.equal(threat.detail, 'Virus:DOS/EICAR_Test_File');
  const failed = parseScanOutput('[Failed][0x80004005] Unspecified error\nCmdTool: Failed with hr = 0x80004005. Check C:\\log for more information');
  assert.equal(failed.result, 'error');
  assert.match(failed.detail, /Failed/);
});

test('which downloads get scanned', () => {
  assert.equal(wantsScan('programs', 'programs'), true);
  assert.equal(wantsScan('programs', 'archives'), true);
  assert.equal(wantsScan('programs', 'video'), false);
  assert.equal(wantsScan('all', 'video'), true);
  assert.equal(wantsScan('off', 'programs'), false);
});

test('Mark of the Web is written next to the file (Windows, NTFS)', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-motw-')), 'setup.exe');
  fs.writeFileSync(file, 'MZ');
  assert.equal(markOfTheWeb(file, { url: 'https://dl.example.com/setup.exe', referrer: 'https://example.com/download' }), true);
  const zone = readMarkOfTheWeb(file);
  assert.match(zone, /ZoneId=3/);
  assert.match(zone, /HostUrl=https:\/\/dl\.example\.com\/setup\.exe/);
  assert.match(zone, /ReferrerUrl=https:\/\/example\.com\/download/);
  const priv = path.join(path.dirname(file), 'private.zip');
  fs.writeFileSync(priv, 'PK');
  markOfTheWeb(priv, { url: 'https://secret.example.com/x.zip', incognito: true });
  assert.doesNotMatch(readMarkOfTheWeb(priv), /secret/);
  assert.match(readMarkOfTheWeb(priv), /HostUrl=about:internet/);
});
