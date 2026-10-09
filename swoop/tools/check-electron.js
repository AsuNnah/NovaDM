'use strict';
// Quick checks of Electron behaviour Swoop relies on. Run: npx electron tools/check-electron.js
const http = require('http');
const path = require('path');
const { app, session, BrowserWindow } = require('electron');
const swoopNet = require(path.join(__dirname, '..', 'src', 'main', 'net.js'));

const results = {};
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/echo' }); return res.end(); }
  if (req.url === '/file') {
    const total = 1000;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const s = Number(m[1]); const e = m[2] ? Number(m[2]) : total - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${total}`, 'Content-Length': e - s + 1, 'Content-Type': 'video/mp4' });
      return res.end(Buffer.alloc(e - s + 1, 1));
    }
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/mp4' });
    return res.end(Buffer.alloc(total, 1));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc' });
  res.end(JSON.stringify(req.headers));
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition('check');
  await ses.cookies.set({ url: base, name: 'token', value: 'xyz' });
  try {
    const r = await swoopNet.fetchText(base + '/redirect', {
      session: ses,
      headers: { referer: 'https://example.com/page', origin: 'https://example.com', 'x-custom': '42', authorization: 'Bearer t' },
    });
    results.redirectFinalUrl = r.finalUrl;
    results.echoedHeaders = JSON.parse(r.text);
  } catch (e) { results.fetchError = String(e); }
  try { results.probe = await swoopNet.probe(base + '/file', { session: ses }); delete results.probe.headers; } catch (e) { results.probeError = String(e); }

  // webRequest listeners coexisting
  let sent = 0; let started = 0;
  ses.webRequest.onSendHeaders(() => { sent++; });
  ses.webRequest.onResponseStarted(() => { started++; });
  ses.webRequest.onBeforeRequest((d, cb) => cb({}));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await win.loadURL(base + '/echo');
  results.webRequestCounts = { sent, started };
  results.widevine = await win.webContents.executeJavaScript(`
    navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
    }]).then(() => 'available').catch((e) => 'unavailable: ' + e.name)`);
  results.clearkey = await win.webContents.executeJavaScript(`
    navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }])
      .then(() => 'available').catch((e) => 'unavailable: ' + e.name)`);
  results.hlsNative = await win.webContents.executeJavaScript(`document.createElement('video').canPlayType('application/vnd.apple.mpegurl')`);
  results.userAgent = ses.getUserAgent();
  // GUI-subsystem exe on Windows: stdout isn't attached, so write a file.
  require('fs').writeFileSync(path.join(require('os').tmpdir(), 'swoop-check.json'), JSON.stringify(results, null, 2));
  app.quit();
});
