'use strict';
// In-app self-test for 1.4.3: Settings → About (opened the way the menu opens it) shows the running
// version, the build and an update status, scrolls into view, and "Check for updates" answers.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v143.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const id = browser.createTab({ url: 'novadm://settings?section=about' });
    const tab = browser.tabs.get(id);
    const read = () => tab.wc.executeJavaScript(`(() => {
      const t = (i) => (document.getElementById(i) || {}).textContent || '';
      const r = document.getElementById('about').getBoundingClientRect();
      return { version: t('aboutVersion'), build: t('aboutBuild'), update: t('aboutUpdate'), inView: r.top >= 0 && r.top < innerHeight };
    })()`).catch(() => null);
    await until(async () => { const r = await read(); return r && r.build; });
    await sleep(800); // the page scrolls to the section after 300 ms
    result.before = await read();
    result.versionOk = result.before.version === `NovaDM ${app.getVersion()}`;
    result.buildOk = /Electron \d/.test(result.before.build) && /Chromium \d/.test(result.before.build);
    await tab.wc.executeJavaScript(`document.getElementById('aboutCheck').click()`);
    result.after = await until(async () => { const r = await read(); return r && r.update !== 'Checking…' && r.update !== result.before.update ? r : null; }, 20000);
    result.checkAnswered = !!result.after;
    result.ok = result.versionOk && result.buildOk && result.before.inView && result.checkAnswered;
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
