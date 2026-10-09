'use strict';
// In-app self-test for the content grabber. Run via NOVADM_SELFTEST with a throwaway NOVADM_USERDATA.
const fs = require('fs');
const os = require('os');
const path = require('path');
const gallery = require('./gallery-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-grab.json');

module.exports = async ({ app, browser, downloads, settings, ipc, overlayView }) => {
  const result = { steps: [] };
  const log = (s) => result.steps.push(s);
  try {
    const { base } = await gallery.start();
    const dlDir = path.join(app.getPath('userData'), 'dl');
    fs.rmSync(dlDir, { recursive: true, force: true });
    settings.set({ downloadDir: dlDir, categoryFolders: true, maxActive: 4 });

    const tab = browser.activeTab();
    const loaded = new Promise((r) => tab.wc.once('did-finish-load', r));
    browser.navigate(tab.id, base + '/gallery.html');
    await loaded;
    await sleep(800);
    log('page loaded');

    const plain = await ipc['grab.scan']({ autoScroll: false });
    const byKind = (items) => items.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {});
    const has = (items, frag) => items.some((i) => i.url.includes(frag));
    result.plain = {
      count: plain.items.length, byKind: byKind(plain.items), title: plain.title,
      lazy: has(plain.items, 'lazy1.png'), srcsetLarge: has(plain.items, 'large.png'), linkFull: has(plain.items, 'full2.jpg'),
      cssBg: has(plain.items, 'bg.png'), poster: has(plain.items, 'poster.png'), pdf: has(plain.items, 'report.pdf'),
      zip: has(plain.items, 'pack.zip'), video: has(plain.items, 'clip.mp4'), noExt: has(plain.items, 'photo123'),
      scrollImages: plain.items.filter((i) => i.url.includes('/scroll/')).length,
      iconDims: (plain.items.find((i) => i.url.includes('icon.png')) || {}).w,
    };
    log('plain scan done');

    const scrolled = await ipc['grab.scan']({ autoScroll: true });
    result.scrolled = { count: scrolled.items.length, scrollImages: scrolled.items.filter((i) => i.url.includes('/scroll/')).length };
    log('auto-scroll scan done');

    // Screenshot of the grabber panel.
    ipc['panel.open']({ name: 'grabber' });
    await sleep(3500);
    const shot = await overlayView.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-grabber.png'), shot.toPNG());
    log('panel screenshot saved');

    // Download a mix: no-extension image, server-named image, hotlink-protected image, PDF, ZIP.
    const pick = scrolled.items.filter((i) => ['photo123', '/dl/named', 'protected/p.png', 'report.pdf', 'pack.zip', 'large.png'].some((f) => i.url.includes(f)));
    await ipc['grab.download']({ items: pick, subfolder: true });
    log(`queued ${pick.length} downloads`);
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const list = downloads.list();
      if (list.length >= pick.length && list.every((d) => d.state === 'done' || d.state === 'error')) break;
      await sleep(300);
    }
    result.downloads = downloads.list().map((d) => ({
      name: d.name, state: d.state, error: d.error,
      rel: path.relative(dlDir, d.savePath),
      bytes: fs.existsSync(d.savePath) ? fs.statSync(d.savePath).size : -1,
      pngHeader: fs.existsSync(d.savePath) ? fs.readFileSync(d.savePath).subarray(1, 4).toString('latin1') === 'PNG' : false,
    }));
    log('downloads finished');
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
