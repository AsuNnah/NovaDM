'use strict';
// In-app self-test for the 0.3.0 features, against a local server only:
//  page download capture + "New download" dialog, duplicates, blob:/POST downloads (browser-handled),
//  batch pattern list, clipboard link, per-download speed limit, checksum check, Refresh link,
//  auto-resume, proxy with sign-in (browser stack and direct transport).
// The real clipboard is never touched. Run with a throwaway NOVADM_USERDATA.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase2.json');
const LOG = OUT + '.log';
const step = (m, extra) => { try { fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${m}${extra ? ' ' + JSON.stringify(extra) : ''}
`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

function startServer(files, stats) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      stats.hits[u.pathname] = (stats.hits[u.pathname] || 0) + 1;
      if (u.pathname === '/page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><title>Test page</title>
          <a id="zip" href="/files/doc.zip">zip</a>
          <a id="blob" download="notes.txt">blob</a>
          <form id="post" method="POST" action="/export"><button>export</button></form>
          <script>const b = new Blob(['hello from a blob'], { type: 'text/plain' }); document.getElementById('blob').href = URL.createObjectURL(b);</script>`);
      }
      if (u.pathname === '/export' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' });
        return res.end('a,b\n1,2\n');
      }
      // Expiring link: token "old" stops working after 300 KB.
      if (u.pathname === '/exp/file.bin') {
        if (u.searchParams.get('t') === 'old' && stats.expired) { res.writeHead(403); return res.end('expired'); }
        return sendRange(req, res, files['/exp/file.bin'], { slow: true, onData: (n) => {
          if (u.searchParams.get('t') === 'old') {
            stats.oldBytes = (stats.oldBytes || 0) + n;
            if (stats.oldBytes > 300 * 1024 && !stats.expired) { stats.expired = true; setTimeout(() => res.destroy(), 0); }
          } else stats.newBytes = (stats.newBytes || 0) + n;
        } });
      }
      const body = files[u.pathname];
      if (!body) { res.writeHead(404); return res.end(); }
      const extra = u.pathname === '/files/doc.zip' ? { 'Content-Disposition': 'attachment; filename="doc.zip"' } : {};
      return sendRange(req, res, body, { extra, slow: u.pathname.startsWith('/slow/') });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function sendRange(req, res, body, { extra = {}, slow = false, onData } = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const s = m ? Number(m[1]) : 0;
  const e = m && m[2] ? Number(m[2]) : body.length - 1;
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', ...extra, ...(m ? { 'Content-Range': `bytes ${s}-${e}/${body.length}` } : {}) });
  let off = s;
  const tick = () => {
    if (res.destroyed) return;
    if (off > e) return res.end();
    const n = Math.min(16 * 1024, e - off + 1);
    if (onData) onData(n);
    res.write(body.subarray(off, off + n)); off += n;
    setTimeout(tick, slow ? 15 : 2);
  };
  tick();
}

// Minimal HTTP proxy (plain http only) that requires Basic sign-in.
function startProxy(stats) {
  return new Promise((resolve) => {
    const want = 'Basic ' + Buffer.from('nova:secret').toString('base64');
    const server = http.createServer((req, res) => {
      if (req.headers['proxy-authorization'] !== want) {
        stats.challenges++;
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
        return res.end();
      }
      stats.proxied++;
      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      const up = http.request(req.url, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(up);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = async ({ app, browser, downloads, settings, overlayView, ipc, addFlow, clipboardWatcher }) => {
  const result = {};
  try { fs.rmSync(LOG, { force: true }); } catch {}
  step('start');
  const ov = () => overlayView.webContents;
  const overlayText = () => ov().executeJavaScript('document.getElementById("content").innerText');
  const clickOverlay = (sel) => ov().executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
  try {
    const files = {
      '/files/doc.zip': crypto.randomBytes(400 * 1024),
      '/files/clip.zip': crypto.randomBytes(100 * 1024),
      '/slow/limited.bin': crypto.randomBytes(1024 * 1024),
      '/files/hashme.bin': crypto.randomBytes(200 * 1024),
      '/exp/file.bin': crypto.randomBytes(2 * 1024 * 1024),
      '/img1.png': Buffer.alloc(1000, 1), '/img2.png': Buffer.alloc(1000, 2), '/img3.png': Buffer.alloc(1000, 3),
    };
    const stats = { hits: {} };
    const { server, base } = await startServer(files, stats);
    const dlDir = path.join(app.getPath('userData'), 'dl-phase2');
    fs.rmSync(dlDir, { recursive: true, force: true });
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: false, clipboardWatch: true, notifyOnComplete: false, connections: 4 });
    const byName = (n) => downloads.list().find((d) => d.name === n);
    const doneByName = (n) => until(() => { const d = byName(n); return d && (d.state === 'done' || d.state === 'error') ? d : null; }, 20000);

    step('section 1', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 1. Clicking a file link in a page opens the "New download" dialog; Download adds it.
    const tabId = browser.createTab({ url: base + '/page.html' });
    const tab = browser.tabs.get(tabId);
    await until(() => !tab.wc.isLoading() && tab.wc.getURL().endsWith('/page.html'));
    await tab.wc.executeJavaScript('document.getElementById("zip").click()');
    const dlg = await until(async () => { const t = await overlayText(); return /New download/.test(t) ? t : null; }, 8000);
    result.captureDialog = { shown: !!dlg, hasName: !!dlg && dlg.includes('doc.zip') || (await ov().executeJavaScript('(document.getElementById("na-name")||{}).value')) === 'doc.zip' };
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-newdownload.png'), (await overlayView.webContents.capturePage()).toPNG());
    await clickOverlay('#na-go');
    const zip = await doneByName('doc.zip');
    result.capture = { state: zip && zip.state, sameBytes: !!zip && fs.readFileSync(zip.savePath).equals(files['/files/doc.zip']) };

    step('section 2', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 2. The same link again: the dialog says it's already downloaded.
    await tab.wc.executeJavaScript('document.getElementById("zip").click()');
    const dup = await until(async () => { const t = await overlayText(); return /already downloaded/.test(t) ? t : null; }, 8000);
    result.duplicateNotice = !!dup;
    await ov().executeJavaScript('document.querySelector(".acts .btn").click()'); // Cancel
    await sleep(300);

    step('section 3', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 3. blob: link and a form POST answer stay with the browser, saved into the folder.
    await tab.wc.executeJavaScript('document.getElementById("blob").click()');
    const blob = await doneByName('notes.txt');
    result.blob = { state: blob && blob.state, native: blob && blob.native, text: blob && blob.state === 'done' ? fs.readFileSync(blob.savePath, 'utf8') : '' };
    await tab.wc.executeJavaScript('document.getElementById("post").submit()');
    const csv = await doneByName('report.csv');
    result.post = { state: csv && csv.state, native: csv && csv.native };

    step('section 4', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 4. Pattern: img[1-3].png -> pick list with 3 links.
    const callIpc = (m, a) => ipc[m](a);
    await callIpc('downloads.addUrl', { url: base + '/img[1-3].png' });
    const list = await until(async () => { const t = await overlayText(); return /Download 3 links/.test(t) ? t : null; }, 5000);
    result.patternList = !!list;
    await clickOverlay('#la-go');
    const imgs = await until(() => ['img1.png', 'img2.png', 'img3.png'].every((n) => (byName(n) || {}).state === 'done'), 15000);
    result.pattern = !!imgs;

    step('section 5', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 5. Copied link (as if from another app) -> "Download the copied link?"
    // The real clipboard may be off limits where tests run (sandbox): feed the watcher directly.
    const fake = 'Have a look: ' + base + '/files/clip.zip';
    clipboardWatcher.read = async () => fake;
    const clip = await until(async () => { const t = await overlayText(); return /Download the copied link/.test(t) ? t : null; }, 6000);
    result.clipboardDialog = !!clip;
    const snap = () => ({
      flowCurrent: addFlow.current ? { kind: addFlow.current.kind, origin: addFlow.current.origin } : null, flowQueue: addFlow.queue.length,
      watcher: { on: !!clipboardWatcher.timer, last: String(clipboardWatcher.last).slice(0, 80) },
      list: downloads.list().map((d) => [d.name, d.state, d.error]),
    });
    result.snapAfterClipboard = snap();
    step('clipboard snapshot', result.snapAfterClipboard);
    await clickOverlay('#na-go');
    result.clipboard = ((await doneByName('clip.zip')) || {}).state;

    // From here on, add without the dialog.
    settings.set({ skipEditor: true });

    step('section 6', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 6. Per-download speed limit: 1 MB at 256 KB/s takes about 4 s.
    const t0 = Date.now();
    downloads.add({ kind: 'http', url: base + '/slow/limited.bin', name: 'limited.bin', speedLimitKBps: 256 });
    const lim = await doneByName('limited.bin');
    const secs = (Date.now() - t0) / 1000;
    result.speedLimit = { state: lim && lim.state, seconds: secs, avgKBps: Math.round(1024 / secs) };
    if (!lim) result.snapAfterLimit = snap();

    step('section 7', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 7. Checksum check: right and wrong.
    const goodHash = crypto.createHash('sha256').update(files['/files/hashme.bin']).digest('hex');
    downloads.add({ kind: 'http', url: base + '/files/hashme.bin', name: 'good.bin', expectedHash: goodHash });
    downloads.add({ kind: 'http', url: base + '/files/hashme.bin?x=2', name: 'bad.bin', expectedHash: 'd41d8cd98f00b204e9800998ecf8427e' });
    await until(() => ['good.bin', 'bad.bin'].every((n) => ['ok', 'mismatch', 'error'].includes((byName(n) || {}).verify)), 15000);
    result.checksum = { good: (byName('good.bin') || {}).verify, bad: (byName('bad.bin') || {}).verify };

    step('section 8', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 8. Refresh link: the old link expires part-way, a new link to the same file continues it.
    settings.set({ connections: 1, retries: 1 });
    downloads.add({ kind: 'http', url: base + '/exp/file.bin?t=old', name: 'expiring.bin', size: files['/exp/file.bin'].length });
    const failed = await until(() => { const d = byName('expiring.bin'); return d && d.state === 'error' ? d : null; }, 20000);
    result.refreshBefore = failed ? { errorCode: failed.errorCode, received: failed.received } : null;
    if (failed) {
      await downloads.refreshLink(failed.id, base + '/exp/file.bin?t=new');
      const fin = await doneByName('expiring.bin');
      result.refresh = {
        state: fin && fin.state, sameBytes: !!fin && fin.state === 'done' && fs.readFileSync(fin.savePath).equals(files['/exp/file.bin']),
        newLinkBytes: stats.newBytes, fileBytes: files['/exp/file.bin'].length,
      };
    }
    settings.set({ connections: 4, retries: 10 });

    step('section 9', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 9. Auto-resume: a download marked as running when NovaDM closed continues.
    const rec = downloads.add({ kind: 'http', url: base + '/files/doc.zip?r=1', name: 'resume-me.zip', start: false });
    rec.wasRunning = true;
    result.autoResume = { resumed: downloads.resumeInterrupted(), state: ((await doneByName('resume-me.zip')) || {}).state };

    step('section 10', { list: downloads.list().map((d) => [d.name, d.state]) });
    // 10. Proxy with sign-in, for the browser stack and the direct transport.
    const pstats = { proxied: 0, challenges: 0 };
    const proxy = await startProxy(pstats);
    step('proxy started');
    settings.set({ proxyUser: 'nova', proxyPassEnc: require('../src/main/proxy').encryptPassword('secret') });
    step('password saved');
    settings.set({ proxyMode: 'manual', proxyType: 'http', proxyServer: '127.0.0.1:' + proxy.port, proxyBypass: '<-loopback>' });
    step('proxy set');
    await sleep(800);
    step('resolving proxy');
    result.proxyResolve = await browser.normalSession.resolveProxy(base + '/x');
    step('resolved', result.proxyResolve);
    const hb = setInterval(() => { const d = downloads.list().find((x) => x.name === 'via-proxy.zip'); step('heartbeat', d ? [d.state, d.received, d.error] : 'none'); }, 2000);
    settings.set({ connections: 8, downloadTransport: 'auto' });
    downloads.add({ kind: 'http', url: base + '/files/doc.zip?p=1', name: 'via-proxy.zip' });
    const vp = await doneByName('via-proxy.zip');
    clearInterval(hb);
    step('proxy download', { vp: vp && [vp.state, vp.error], pstats });
    result.proxy = { state: vp && vp.state, error: vp && vp.error, proxied: pstats.proxied, challenges: pstats.challenges };
    settings.set({ proxyMode: 'system', proxyServer: '', proxyUser: '', proxyPassEnc: '' });
    proxy.server.close();
    server.close();
    step('servers closed');
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
