'use strict';
// In-app self-test for 0.7.0 (other browsers and apps), against local servers only:
//  - local API: off -> on, the extension's kind of requests (dialog / start), web pages refused
//  - novadm:// link and --add --start from a second start
//  - a site extension in the real sandbox: finds files, its own fetch() is blocked by the sandbox,
//    other sites are refused; results appear in the media panel and download
//  - yt-dlp (a stand-in answering like yt-dlp -J): choices; "picture + sound" from separate MP4
//    files with an index is merged and then played in Chromium with picture and sound
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const muxjs = require('mux.js');
const { makeBox } = require('../src/main/media/mp4');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase6.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(120); } return null; };
const TS = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts'));

function indexedFile(type, n) {
  let init = null; const frags = [];
  for (let k = 0; k < n; k++) {
    const tx = new muxjs.mp4.Transmuxer({ remux: false, baseMediaDecodeTime: k * 180000 });
    tx.on('data', (s) => { if (s.type !== type) return; if (!init) init = Buffer.from(s.initSegment); frags.push(Buffer.from(s.data)); });
    tx.push(new Uint8Array(TS)); tx.flush();
  }
  const body = Buffer.alloc(24 + frags.length * 12);
  body.writeUInt32BE(1, 4); body.writeUInt32BE(90000, 8); body.writeUInt16BE(frags.length, 22);
  frags.forEach((f, i) => { body.writeUInt32BE(f.length, 24 + i * 12); body.writeUInt32BE(180000, 28 + i * 12); body.writeUInt32BE(0x90000000, 32 + i * 12); });
  return Buffer.concat([init, makeBox('sidx', body), ...frags]);
}

function server(files) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u.startsWith('/play/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><video id="v" muted autoplay src="/files/${u.slice(6)}"></video>`);
      }
      const f = files[u];
      if (!f) { res.writeHead(404); return res.end(); }
      const [type, body] = Array.isArray(f) ? f : ['application/octet-stream', typeof f === 'string' && fs.existsSync(f) ? fs.readFileSync(f) : f];
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (m) {
        const a = Number(m[1]); const b = Math.min(Number(m[2]), buf.length - 1);
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
        return res.end(buf.subarray(a, b + 1));
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
      res.end(buf);
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

function call(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.end(data);
  });
}

module.exports = async ({ app, browser, media, downloads, settings, ipc, overlayView, siteExt, ytdlp, handleLaunch }) => {
  const result = {};
  const overlayText = () => overlayView.webContents.executeJavaScript('document.getElementById("content").innerText');
  const closeDialog = () => overlayView.webContents.executeJavaScript('(() => { const b = [...document.querySelectorAll(".acts .btn")].find(x => x.textContent === "Cancel"); if (b) b.click(); })()');
  const byName = (n) => downloads.list().find((d) => d.name === n);
  try {
    const files = {
      '/files/api.bin': Buffer.alloc(200 * 1024, 1), '/files/link.bin': Buffer.alloc(100 * 1024, 2), '/files/cli.bin': Buffer.alloc(100 * 1024, 3),
      '/files/ext-a.zip': Buffer.alloc(50 * 1024, 4), '/files/ext-b.mp4': ['video/mp4', Buffer.alloc(60 * 1024, 5)],
      '/media/v.mp4': ['video/mp4', indexedFile('video', 3)], '/media/a.m4a': ['audio/mp4', indexedFile('audio', 3)],
      '/gallery/7': ['text/html', '<!doctype html><title>Album 7</title><p>album</p>'],
      '/api/album/7.json': ['application/json', JSON.stringify({ items: [{ file: 'ext-a.zip' }, { file: 'ext-b.mp4', video: true }] })],
    };
    const { s, base } = await server(files);
    const dlDir = path.join(app.getPath('userData'), 'dl-phase6');
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: false, notifyOnComplete: false });

    // 1. Local API
    const ping0 = await call(9614, 'GET', '/api/v1/ping');
    settings.set({ apiEnabled: true, apiPort: 0 });
    await sleep(600);
    const st = await ipc['integration.status']();
    const port = st.port;
    const key = settings.get('apiKey');
    const ext = { authorization: `Bearer ${key}`, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', host: `127.0.0.1:${port}` };
    const started = await call(port, 'POST', '/api/v1/downloads', { headers: ext, body: { url: base + '/files/api.bin', referer: base + '/page', cookies: 'from=chrome', start: true } });
    const asked = await call(port, 'POST', '/api/v1/downloads', { headers: ext, body: { url: base + '/files/link.bin' } });
    const dialog = await until(async () => /New download/.test(await overlayText()), 5000);
    await closeDialog();
    const web = await call(port, 'POST', '/api/v1/downloads', { headers: { ...ext, origin: 'https://evil.example' }, body: { url: base + '/files/api.bin', start: true } });
    const apiDone = await until(() => { const d = byName('api.bin'); return d && d.state === 'done' && d; });
    result.api = { offByDefault: ping0.status === 0, running: st.running, startedOk: started.body && started.body.ok, askedPending: asked.body && asked.body.pending, dialog: !!dialog, webPageStatus: web.status, apiDownload: apiDone && apiDone.state, cookieKept: apiDone ? downloads.get(apiDone.id).headers.cookie : null };

    // 2. novadm:// link (dialog) and --add --start (straight away)
    handleLaunch(['NovaDM.exe', `novadm://add?url=${encodeURIComponent(base + '/files/link.bin')}&name=Linked.bin`]);
    result.deepLinkDialog = !!(await until(async () => /Linked\.bin|New download/.test(await overlayText()), 5000));
    await closeDialog();
    handleLaunch(['NovaDM.exe', '--add', base + '/files/cli.bin', '--name', 'cli.bin', '--start']);
    result.cliStart = ((await until(() => { const d = byName('cli.bin'); return d && d.state === 'done' && d; })) || {}).state;

    // 3. Site extension in the real sandbox
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ext-'));
    fs.writeFileSync(path.join(extDir, 'novadm-extension.json'), JSON.stringify({ name: 'Local gallery', version: '1.0', matches: ['http://127.0.0.1/*'], script: 'index.js' }));
    fs.writeFileSync(path.join(extDir, 'index.js'), `
      novadm.onResolve(async (page) => {
        let direct = 'allowed';
        try { await fetch('${base}/api/album/7.json'); } catch (e) { direct = 'blocked'; }
        let other = 'allowed';
        try { await novadm.fetchText('https://example.com/'); } catch (e) { other = 'refused'; }
        const id = /\\/gallery\\/(\\d+)/.exec(page.url)[1];
        const album = await novadm.fetchJson('${base}/api/album/' + id + '.json');
        return album.items.map((it) => ({ url: '${base}/files/' + it.file, name: direct + '-' + other + '-' + it.file, kind: it.video ? 'video' : 'file' }));
      });`);
    siteExt.confirm = async () => true; // the real dialog is skipped in the test
    const inst = await siteExt.installFromFolder(extDir);
    const tabId = browser.createTab({ url: base + '/gallery/7' });
    const found = await until(() => { const l = media.list(tabId).items.filter((i) => i.source === 'Local gallery'); return l.length === 2 && l; }, 10000);
    result.siteExtension = { installed: inst.ok, found: found ? found.map((i) => i.name) : media.list(tabId).items.map((i) => i.name) };
    if (found) {
      browser.selectTab(tabId);
      settings.set({ skipEditor: true });
      await ipc['media.download']({ id: found[0].id });
      result.siteExtension.downloaded = ((await until(() => { const d = byName(found[0].name); return d && d.state === 'done' && d; })) || {}).state;
    }

    // 4. yt-dlp (stand-in) -> merged picture + sound -> played in Chromium
    ytdlp.runner = async (args) => JSON.stringify({
      title: 'Talk', duration: 6, webpage_url: args[args.length - 1],
      formats: [
        { format_id: 'v', protocol: 'http', url: base + '/media/v.mp4', ext: 'mp4', height: 300, vcodec: 'avc1', acodec: 'none' },
        { format_id: 'a', protocol: 'http', url: base + '/media/a.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128 },
      ],
    });
    const yTab = browser.createTab({ url: base + '/gallery/7' });
    await until(() => !browser.tabs.get(yTab).wc.isLoading(), 5000);
    browser.selectTab(yTab);
    const yf = await ipc['media.ytdlpFind']();
    result.ytdlp = { ok: yf.ok, choices: yf.choices };
    if (yf.ok) {
      await ipc['media.ytdlpDownload']({ index: 0 });
      const yd = await until(() => { const d = downloads.list().find((x) => x.name.startsWith('Talk') && ['done', 'error'].includes(x.state)); return d; }, 20000);
      result.ytdlp.state = yd && yd.state; result.ytdlp.error = yd && yd.error;
      if (yd && yd.state === 'done') {
        files['/files/talk.mp4'] = ['video/mp4', fs.readFileSync(yd.savePath)];
        const pTab = browser.createTab({ url: base + '/play/talk.mp4' });
        await sleep(2500);
        result.ytdlp.playback = await browser.tabs.get(pTab).wc.executeJavaScript(`(() => { const v = document.getElementById('v'); return { duration: v.duration, width: v.videoWidth, time: v.currentTime, videoBytes: v.webkitVideoDecodedByteCount, audioBytes: v.webkitAudioDecodedByteCount }; })()`);
      }
    }
    s.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
