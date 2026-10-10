'use strict';
// In-app self-test for automatic updates (run with NOVADM_TEST_AUTOUPDATE=1): a local stand-in for a
// GitHub release serves latest.yml and an "installer". The update must download, pass its SHA-512
// check and show the Update button; a file that doesn't match its checksum must be refused.
// Nothing is installed (quitAndInstall is never called).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-updater.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

module.exports = async ({ app, ipc, chromeView, overlayView }) => {
  const result = {};
  const cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'novadm-test-updater');
  try {
    const { autoUpdater } = require('electron-updater');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-upd-'));
    const installer = crypto.randomBytes(600 * 1024);
    const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');
    let release = { version: '9.9.9', file: installer, claimedSha: sha(installer) };
    const asked = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url);
      const name = `NovaDM-Setup-${release.version}.exe`;
      if (req.url.startsWith('/latest.yml')) {
        return res.end(`version: ${release.version}\nfiles:\n  - url: ${name}\n    sha512: ${release.claimedSha}\n    size: ${release.file.length}\npath: ${name}\nsha512: ${release.claimedSha}\nreleaseDate: '2026-10-11T00:00:00.000Z'\n`);
      }
      if (req.url === '/' + name) { res.setHeader('content-length', release.file.length); return res.end(release.file); }
      res.statusCode = 404; res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const cfg = path.join(work, 'dev-app-update.yml');
    fs.writeFileSync(cfg, `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: novadm-test-updater\n`);
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = cfg;

    // 1. A real update: downloaded, checked, then the Update button and "Restart to update".
    let installs = 0;
    autoUpdater.quitAndInstall = () => { installs++; }; // never install in a test
    await ipc['update.check']();
    const ready = await until(() => { const u = ipc['addons.state']().update; return u && u.phase === 'ready' && u; });
    await sleep(400);
    ipc['panel.open']({ name: 'menu' });
    await sleep(400);
    result.update = {
      phase: ready && ready.phase, version: ready && ready.version,
      pill: await chromeView.webContents.executeJavaScript("!document.getElementById('update-pill').classList.contains('hidden') && document.getElementById('update-pill').textContent"),
      menu: (await overlayView.webContents.executeJavaScript("document.getElementById('content').innerText")).split(/\n/).filter((l) => /ready|Restart/.test(l)),
      downloaded: asked.filter((u) => /\.exe$/.test(u)).length,
    };
    ipc['update.install']();
    result.update.installCalled = installs === 1;
    ipc['panel.close']();

    // 2. A tampered file (checksum doesn't match): refused, never "ready".
    // The release claims one checksum but serves different bytes (as if swapped on the way).
    release = { version: '9.9.10', file: crypto.randomBytes(600 * 1024), claimedSha: sha(crypto.randomBytes(600 * 1024)) };
    const before = asked.length;
    await ipc['update.check']();
    const after = await until(() => { const u = ipc['addons.state']().update; return u && u.version === '9.9.10' && u.phase !== 'downloading' && u; }, 20000);
    result.tampered = { phase: after && after.phase, error: after && (after.error || '').slice(0, 80), downloadedAgain: asked.slice(before).some((u) => /9.9.10.exe$/.test(u)) };
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
