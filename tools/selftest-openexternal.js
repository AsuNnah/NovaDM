'use strict';
// In-app self-test: links opened from NovaDM's toolbar view reach the default program only when they
// are http(s) or mailto (shell.openExternal is replaced by a recorder; nothing is really opened).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-openexternal.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, chromeView }) => {
  const result = {};
  const opened = [];
  const real = shell.openExternal;
  shell.openExternal = async (url) => { opened.push(url); };
  try {
    const tries = ['https://example.com/', 'mailto:someone@example.com', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)'];
    for (const url of tries) {
      await chromeView.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}); true`).catch(() => {});
      await sleep(150);
    }
    result.opened = opened;
    result.ok = opened.length === 2 && opened[0] === tries[0] && opened[1] === tries[1];
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  } finally {
    shell.openExternal = real;
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
