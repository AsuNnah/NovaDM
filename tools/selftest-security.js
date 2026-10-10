'use strict';
// In-app self-test for the leaked-password and insecure-sign-in warnings, offline: a local stand-in
// for Have I Been Pwned's range API, and a local proxy that plays a plain-http shop site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-security.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const LOGIN = '<!doctype html><title>Sign in</title><form onsubmit="event.preventDefault();document.title=\'sent\'"><input id="u" value="me"><input id="p" type="password"><button id="go">Sign in</button></form>';

module.exports = async ({ app, browser, settings, overlayView }) => {
  const result = {};
  try {
    const breach = require('../src/main/breach');
    const hibp = { asked: [] };
    const leaked = crypto.createHash('sha1').update('hunter2').digest('hex').toUpperCase();
    const api = http.createServer((req, res) => {
      hibp.asked.push({ path: req.url, padding: req.headers['add-padding'], cookie: req.headers.cookie || '' });
      res.end(`${leaked.slice(5)}:17043\r\n${'F'.repeat(35)}:0`);
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    breach.api = `http://127.0.0.1:${api.address().port}/range/`;
    const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(LOGIN); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));

    const tab = browser.activeTab();
    const overlay = () => overlayView.webContents.executeJavaScript('document.getElementById("content").innerText').catch(() => '');
    const signIn = async (url, password) => {
      await overlayView.webContents.executeJavaScript('document.getElementById("content").innerHTML = ""').catch(() => {});
      browser.navigate(tab.id, url);
      await until(() => !tab.wc.isLoading() && /Sign in/.test(tab.wc.getTitle()));
      await sleep(300);
      await tab.wc.executeJavaScript('document.getElementById("p").focus()');
      for (const ch of password) tab.wc.sendInputEvent({ type: 'char', keyCode: ch });
      const r = await tab.wc.executeJavaScript('(() => { const b = document.getElementById("go").getBoundingClientRect(); return { x: Math.round(b.left + 5), y: Math.round(b.top + 5) }; })()');
      for (const type of ['mouseDown', 'mouseUp']) tab.wc.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(1200);
      return overlay();
    };

    // 1. A leaked password on an https-less local page: breach warning only (local pages are fine).
    settings.set({ breachCheck: true, httpsUpgrade: false });
    const t1 = await signIn(`http://127.0.0.1:${site.address().port}/login`, 'hunter2');
    result.leaked = { warned: /found in a data breach/.test(t1), count: /17,043/.test(t1), asked: hibp.asked.slice() };
    result.leaked.onlyPrefixSent = hibp.asked.length === 1 && hibp.asked[0].path === '/range/' + leaked.slice(0, 5);

    // 2. A plain-http shop site (through a local proxy): "sent without encryption"; unique password.
    const proxy = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(LOGIN); });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    await browser.normalSession.setProxy({ proxyRules: `http=127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
    const t2 = await signIn('http://shop.example/login', 'unique-' + Date.now());
    result.insecure = { warned: /sent without encryption/.test(t2), names: /shop\.example/.test(t2) };
    await browser.normalSession.setProxy({ mode: 'system' });

    // 2b. A sign-in box embedded from another site (localhost inside a 127.0.0.1 page): warned, naming the frame's site.
    const port = site.address().port;
    const host = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>Shop</title><iframe id="f" src="http://localhost:${port}/login" style="width:400px;height:200px;border:0"></iframe>`); });
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    await overlayView.webContents.executeJavaScript('document.getElementById("content").innerHTML = ""').catch(() => {});
    browser.navigate(tab.id, `http://127.0.0.1:${host.address().port}/`);
    await until(() => !tab.wc.isLoading() && tab.wc.mainFrame.frames.length && /Sign in/.test(String(tab.wc.mainFrame.frames[0].url) + '') === false);
    await sleep(800);
    const frame = tab.wc.mainFrame.frames[0];
    // Real input through Chromium's input router (DevTools protocol): Electron's sendInputEvent does not
    // reach frames of another site, and script focus can't move the keyboard into them.
    const off = await tab.wc.executeJavaScript('(() => { const r = document.getElementById("f").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()');
    const at = (id) => frame.executeJavaScript(`(() => { const b = document.getElementById("${id}").getBoundingClientRect(); return { x: Math.round(b.left + 5), y: Math.round(b.top + 5) }; })()`);
    const dbg = tab.wc.debugger;
    dbg.attach('1.3');
    const click = async (p) => { for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: off.x + p.x, y: off.y + p.y, button: 'left', clickCount: 1 }); };
    await click(await at('p'));
    await sleep(200);
    await dbg.sendCommand('Input.insertText', { text: 'hunter2' });
    await click(await at('go'));
    dbg.detach();
    await sleep(1200);
    const t2b = await overlay();
    result.embedded = { warned: /found in a data breach/.test(t2b), namesFrameSite: /localhost/.test(t2b), typed: await frame.executeJavaScript('document.getElementById("p").value.length'), submitted: await frame.executeJavaScript('document.title') };
    host.close();

    // 3. Setting off: no lookup at all.
    settings.set({ breachCheck: false });
    const before = hibp.asked.length;
    const t3 = await signIn(`http://127.0.0.1:${site.address().port}/login2`, 'another-one-' + Date.now());
    result.off = { lookups: hibp.asked.length - before, warned: /breach/.test(t3) };
    settings.set({ breachCheck: true });
    api.close(); site.close(); proxy.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
