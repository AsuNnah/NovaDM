'use strict';
// In-app self-test for 1.2 (shortcuts, Tor-style protections), against a local server only.
// Two runs on one profile: NOVADM_V1_PHASE=1 checks everything and chooses the Safer level;
// phase 2 checks that Safer turned the JIT compiler off after the restart.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PHASE = process.env.NOVADM_V1_PHASE || '1';
const OUT = path.join(os.tmpdir(), `novadm-selftest-v12-${PHASE}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const settle = async (tab) => { await sleep(150); await until(() => tab.wc && !tab.wc.isLoading()); await sleep(300); };

// What a fingerprinting script reads.
const FP = `(function(){var c=document.createElement('canvas');c.width=200;c.height=40;var x=c.getContext('2d');x.fillStyle='#f60';x.fillRect(10,5,80,20);x.fillStyle='#069';x.font='14px Arial';x.fillText('fingerprint',12,22);
var d=c.toDataURL();var h=0;for(var i=0;i<d.length;i++)h=(h*31+d.charCodeAt(i))|0;var g=document.createElement('canvas').getContext('webgl');
window.__fp={canvas:h,cpu:navigator.hardwareConcurrency,screen:screen.width,battery:typeof navigator.getBattery,usb:typeof navigator.usb,webgl:!!g};document.title='ran';})();`;

module.exports = async ({ app, browser, settings, ipc, chromeView, downloads }) => {
  const result = {};
  try {
    if (PHASE === '2') {
      result.jitless = app.commandLine.getSwitchValue('js-flags');
      result.level = settings.get('securityLevel');
      settings.set({ securityLevel: 'standard' });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      app.exit(0);
      return;
    }
    const seen = { fonts: 0 };
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u.endsWith('.woff2')) { seen.fonts++; res.writeHead(200, { 'content-type': 'font/woff2' }); return res.end(Buffer.alloc(100)); }
      if (u === '/fp.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(FP); }
      if (u === '/file.zip') { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 4 }); return res.end('PK..'); }
      res.writeHead(200, { 'content-type': 'text/html' });
      if (u === '/media') return res.end('<title>media</title><video id="v" autoplay muted loop src="/none.mp4"></video>');
      if (u === '/link') return res.end('<title>link</title><a id="a" href="/file.zip" style="display:block;font-size:40px">download me</a>');
      res.end(`<title>page ${u}</title><style>@font-face{font-family:F;src:url(/f.woff2)}p{font-family:F}</style><p>text</p><script src="/fp.js"></script>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const a = `http://127.0.0.1:${server.address().port}`;
    const b = `http://localhost:${server.address().port}`; // another site, same server
    settings.set({ httpsUpgrade: false, skipEditor: true, downloadDir: path.join(app.getPath('userData'), 'dl'), categoryFolders: false });
    const tab = browser.activeTab();
    const go = async (url) => { browser.navigate(tab.id, url); await settle(tab); return tab.wc.executeJavaScript('({ fp: window.__fp || null, title: document.title })'); };

    // 1. Fingerprinting: Standard (noise) differs per site; per-site off gives the real values; Strict blocks.
    const std1 = await go(a + '/p1');
    const std1again = await go(a + '/p2');
    const std2 = await go(b + '/p1');
    browser.navigate(tab.id, a + '/p1'); await settle(tab);
    await ipc['shields.toggleHardening']();
    await settle(tab);
    const real = (await tab.wc.executeJavaScript('({ fp: window.__fp })')).fp;
    result.shieldsState = (await ipc['shields.state'] ? ipc['shields.state']() : null);
    await ipc['shields.toggleHardening']();
    settings.set({ fingerprinting: 'strict' });
    const strict = await go(a + '/p3');
    settings.set({ fingerprinting: 'standard' });
    result.fingerprinting = {
      sameSiteSameNoise: std1.fp.canvas === std1again.fp.canvas,
      otherSiteOtherNoise: std1.fp.canvas !== std2.fp.canvas,
      noiseDiffersFromReal: std1.fp.canvas !== real.canvas,
      standardKeepsRealValues: std1.fp.cpu === real.cpu && std1.fp.screen === real.screen && std1.fp.battery === real.battery, // bot checks compare with workers
      real: { cpu: real.cpu, screen: real.screen, battery: real.battery, usb: real.usb, webgl: real.webgl },
      strict: { webgl: strict.fp.webgl, blankCanvas: strict.fp.canvas !== real.canvas, cpu: strict.fp.cpu, screen: strict.fp.screen, battery: strict.fp.battery, usb: strict.fp.usb },
    };

    // 2. Safer: no web fonts, no JavaScript on http:// pages, media waits for a click. Safest: no JavaScript.
    settings.set({ securityLevel: 'safer' });
    seen.fonts = 0;
    const safer = await go(a + '/p4');
    const media = await go(a + '/media');
    result.safer = { scriptRan: safer.title === 'ran', fontRequests: seen.fonts, autoplay: await tab.wc.executeJavaScript('document.getElementById("v").autoplay') };
    void media;
    settings.set({ securityLevel: 'safest' });
    result.safest = { scriptRan: (await go(a + '/p5')).title === 'ran' };
    settings.set({ securityLevel: 'standard' });
    seen.fonts = 0;
    result.standard = { scriptRan: (await go(a + '/p6')).title === 'ran', fontRequests: seen.fonts };

    // 3. Shortcuts from a page.
    const key = (keyCode, modifiers = []) => { tab.wc.focus(); tab.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); };
    const before = browser.order.length;
    const extra = browser.tabs.get(browser.createTab({ url: a + '/closed-me' }));
    await settle(extra);
    browser.closeTab(extra.id);
    browser.selectTab(tab.id);
    key('T', ['control', 'shift']); await sleep(1200);
    const reopened = browser.activeTab();
    result.shortcuts = { reopen: browser.order.length === before + 1 && /closed-me/.test(reopened.url) };
    key('1', ['control']); await sleep(300);
    result.shortcuts.ctrl1 = browser.activeId === browser.order[0];
    key('U', ['control']); await sleep(1500);
    result.shortcuts.viewSource = /^view-source:/.test(browser.activeTab().wc.getURL());
    browser.closeTab(browser.activeId);
    browser.selectTab(tab.id);
    key('F12'); await sleep(1500);
    result.shortcuts.devtools = tab.wc.isDevToolsOpened();
    tab.wc.closeDevTools();
    key('D', ['control', 'shift']); await sleep(300);
    result.shortcuts.bookmarkAll = (await ipc['bookmarks.state']()).items.filter((x) => /^Tabs /.test(x.folder)).length;
    // From the toolbar: Ctrl+T opens a tab there too.
    const n = browser.order.length;
    chromeView.webContents.focus();
    chromeView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
    await sleep(600);
    result.shortcuts.fromToolbar = browser.order.length === n + 1;

    // 4. Alt+click a link: NovaDM downloads it.
    browser.selectTab(tab.id);
    await go(a + '/link');
    const r = await tab.wc.executeJavaScript('(() => { const b = document.getElementById("a").getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + 20) }; })()');
    tab.wc.focus();
    for (const type of ['mouseDown', 'mouseUp']) tab.wc.sendInputEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
    const dl = await until(() => downloads.list().find((d) => d.name === 'file.zip'), 6000);
    result.altClick = { downloaded: !!dl, pageStayed: /\/link$/.test(tab.wc.getURL()) };

    // For phase 2: choose Safer (the JIT part applies after the restart).
    settings.set({ securityLevel: 'safer' });
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.quit();
};
