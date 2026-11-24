'use strict';
// 1.8.2 "Don't lose downloads" (audit 2026-11-24).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { DownloadManager } = require('../src/main/download/manager');

test('AU-16: the downloads list still goes out while progress keeps coming', async () => {
  const m = Object.assign(new EventEmitter(), { _listTimer: null });
  let sent = 0;
  m.on('changed', () => sent++);
  const t = setInterval(() => DownloadManager.prototype.emitList.call(m), 40);
  await new Promise((r) => setTimeout(r, 520));
  clearInterval(t);
  assert.ok(sent >= 3, `sent ${sent} times in 520 ms`);
});

test('AU-05: the toolbar Downloads panel never cancels (and deletes) a download', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/ui/panel.js'), 'utf8');
  assert.ok(!src.includes("'downloads.cancel'"), 'cancel stays on the Downloads page, which asks first');
  assert.match(src, /if \(d\.state === 'done'\) actions\.append\([^\n]*'downloads\.remove'/);
});
