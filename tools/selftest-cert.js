'use strict';
// In-app self-test for 1.5.1: a site with an untrusted certificate (self-signed, NOVADM_TLS_DIR with
// key.pem / cert.pem) shows Chrome's style of warning; Advanced → "Proceed to … (unsafe)" opens it
// with no lock; the exception covers that certificate only, normal windows only, until NovaDM closes.
// Screenshot: %TEMP%\novadm-cert-warning.png
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-cert.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const dir = process.env.NOVADM_TLS_DIR;
    if (!dir) throw new Error('set NOVADM_TLS_DIR (key.pem, cert.pem)');
    const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Router page</title>ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${server.address().port}/`;
    const host = `127.0.0.1:${server.address().port}`;
    const read = (wc) => wc.executeJavaScript(`(() => ({
      title: document.getElementById('title') && document.getElementById('title').textContent,
      hint: document.getElementById('hint') && document.getElementById('hint').textContent,
      buttons: [...document.querySelectorAll('.buttons button')].map((b) => b.textContent + (getComputedStyle(b).order === '-1' ? ' (left)' : '')),
      advHidden: document.getElementById('adv') && document.getElementById('adv').hidden,
      proceed: document.getElementById('proceed') && document.getElementById('proceed').textContent,
      page: document.title,
    }))()`).catch(() => null);

    const id = browser.createTab({ url });
    const tab = browser.tabs.get(id);
    result.warning = await until(async () => { const r = await read(tab.wc); return r && r.title === 'Your connection is not private' ? r : null; });
    await tab.wc.executeJavaScript("document.getElementById('settings').click()");
    await sleep(200);
    result.afterAdvanced = await read(tab.wc);
    try { fs.writeFileSync(path.join(os.tmpdir(), 'novadm-cert-warning.png'), (await tab.wc.capturePage()).toPNG()); } catch (e) { result.screenshot = String(e.message); } // fails while the screen sleeps
    result.lockOnWarning = tab.secure;
    await tab.wc.executeJavaScript("document.getElementById('proceed').click()");
    result.opened = !!(await until(() => tab.wc.getTitle() === 'Router page'));
    result.lockAfterProceed = tab.secure;

    // The same site again in a new tab: no warning this time.
    const id2 = browser.createTab({ url });
    result.secondTabOpens = !!(await until(() => browser.tabs.get(id2).wc.getTitle() === 'Router page'));
    // A private window keeps its own decisions: it warns again.
    const pid = browser.createTab({ url, incognito: true });
    const ptab = browser.tabs.get(pid);
    const pw = await until(async () => { const r = await read(ptab.wc); return r && r.title ? r : null; });
    result.privateWarns = !!(pw && pw.title === 'Your connection is not private');
    browser.closeTab(pid);
    // Only the certificate that was trusted: the same address with another certificate (key2.pem /
    // cert2.pem, if present) warns again.
    if (fs.existsSync(path.join(dir, 'cert2.pem'))) {
      const port = server.address().port;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      const server2 = https.createServer({ key: fs.readFileSync(path.join(dir, 'key2.pem')), cert: fs.readFileSync(path.join(dir, 'cert2.pem')) }, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Other cert</title>x'); });
      await new Promise((r) => server2.listen(port, '127.0.0.1', r));
      await browser.normalSession.closeAllConnections();
      const id3 = browser.createTab({ url: url + 'again' });
      const r3 = await until(async () => { const r = await read(browser.tabs.get(id3).wc); return r && (r.title || r.page === 'Other cert') ? r : null; });
      result.otherCert = r3;
      result.otherCertWarns = !!(r3 && r3.title === 'Your connection is not private');
      server2.close();
    } else result.otherCertWarns = 'not run (no cert2.pem)';

    const w = result.warning || {};
    const a = result.afterAdvanced || {};
    result.checks = {
      warningPage: w.title === 'Your connection is not private' && /steal your information from 127\.0\.0\.1/.test(w.hint || '') && w.advHidden === true,
      buttons: JSON.stringify(w.buttons) === JSON.stringify(['Back to safety', 'Advanced (left)']),
      advanced: a.advHidden === false && a.proceed === `Proceed to ${host} (unsafe)` && a.buttons.includes('Hide advanced (left)'),
      proceeds: result.opened,
      noLock: result.lockAfterProceed === false,
      secondTab: result.secondTabOpens,
      privateApart: result.privateWarns,
      certSpecific: result.otherCertWarns === true || typeof result.otherCertWarns === 'string',
    };
    result.ok = Object.values(result.checks).every(Boolean);
    if (server.listening) server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
