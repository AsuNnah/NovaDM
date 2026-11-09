'use strict';
// In-app self-test for 1.8.0 My filters (REQ-311): Settings → My filters → Save blocks at once and says how many rules
// are on; a line that is not a rule is named; more than 2,000 lines is refused and the saved rules stay.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-myfilters.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

module.exports = async ({ app, browser, adblock, settings }) => {
  const result = {};
  try {
    result.ready = !!(await until(() => adblock.ready, 90000));
    const id = browser.createTab({ url: 'novadm://settings' });
    const wc = browser.tabs.get(id).wc;
    await until(() => wc.executeJavaScript("!!document.getElementById('myFiltersSave') && document.getElementById('myFiltersStatus').textContent !== ''").catch(() => false));
    const saveText = async (text) => {
      await wc.executeJavaScript(`document.getElementById('myFilters').value = ${JSON.stringify(text)}; document.getElementById('myFiltersSave').click();`);
      await sleep(600);
      return wc.executeJavaScript("document.getElementById('myFiltersStatus').textContent");
    };
    result.status = await saveText('! test\n||ads-selftest.test^\n##');
    result.blocked = adblock.isAdUrl('https://ads-selftest.test/a.js', 'https://page-selftest.test/');
    result.tooBig = await saveText('||x.test^\n'.repeat(2001));
    result.kept = settings.get('myFilters');
    result.mainRefuses = Object.keys(settings.set({ myFilters: 'x\n'.repeat(2001) })).length === 0;
    result.checks = {
      ready: result.ready,
      saidOn: /^1 rule on\. Not understood: line 3\.$/.test(result.status || ''),
      blocksAtOnce: result.blocked === true,
      tooBigRefused: /at most 2,000/.test(result.tooBig || '') && result.kept === '! test\n||ads-selftest.test^\n##',
      mainRefuses: result.mainRefuses && settings.get('myFilters') === result.kept,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
