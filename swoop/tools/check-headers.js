'use strict';
// Which replayed request headers does Electron's net module accept? Run with electron.
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, session } = require('electron');
const swoopNet = require(path.join(__dirname, '..', 'src', 'main', 'net.js'));

const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/echo' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.headers));
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition('check2');
  await ses.cookies.set({ url: base, name: 'token', value: 'xyz' });
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    const k = Object.keys(h).find((x) => x.toLowerCase() === 'x-swoop-referer');
    if (!k) return cb({});
    const ref = h[k];
    delete h[k];
    h.Referer = ref;
    cb({ requestHeaders: h });
  });
  const cases = {
    viaHook: { 'x-swoop-referer': 'https://example.com/page?x=1' },
    none: {}, referer: { referer: 'https://example.com/page' }, origin: { origin: 'https://example.com' },
    custom: { 'x-custom': '42' }, auth: { authorization: 'Bearer t' }, accept: { accept: '*/*' },
  };
  const out = {};
  for (const [name, headers] of Object.entries(cases)) {
    for (const p of ['/echo', '/redirect']) {
      try {
        const r = await swoopNet.fetchText(base + p, { session: ses, headers });
        const echo = JSON.parse(r.text);
        out[`${name} ${p}`] = { ok: true, referer: echo.referer, origin: echo.origin, custom: echo['x-custom'], auth: echo.authorization, cookie: echo.cookie };
      } catch (e) {
        out[`${name} ${p}`] = { ok: false, error: String(e.message || e) };
      }
    }
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'swoop-check-headers.json'), JSON.stringify(out, null, 2));
  app.quit();
});
