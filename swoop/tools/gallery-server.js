'use strict';
// Local test gallery for the content grabber.
const http = require('http');
const { swatch } = require('./png');

const IMAGES = {
  'a.png': [800, 600, [70, 130, 220]], 'small.png': [300, 200, [220, 120, 60]], 'large.png': [1600, 1000, [220, 120, 60]],
  'lazy1.png': [640, 480, [60, 180, 120]], 'thumb2.png': [150, 100, [180, 70, 160]], 'full2.jpg': [1200, 900, [180, 70, 160]],
  'bg.png': [300, 200, [200, 190, 60]], 'icon.png': [16, 16, [120, 120, 120]], 'poster.png': [640, 360, [40, 40, 40]],
};
const cache = new Map();
function png(name, w, h, color) {
  const key = `${name}:${w}x${h}`;
  if (!cache.has(key)) cache.set(key, swatch(w, h, color));
  return cache.get(key);
}

function page(base) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Swoop test gallery</title>
<style>body{font-family:sans-serif;background:#f4f4f4;margin:20px} img{max-width:240px;margin:6px;vertical-align:top}</style></head>
<body><h1>Swoop test gallery</h1>
<img src="/img/a.png" alt="Blue photo">
<img src="/img/small.png" srcset="/img/small.png 300w, /img/large.png 1600w" sizes="240px" alt="Orange photo">
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy1.png" alt="Lazy green photo">
<a href="/img/full2.jpg"><img src="/img/thumb2.png" alt="Purple thumbnail"></a>
<div style="display:inline-block;width:300px;height:200px;background-image:url('/img/bg.png')"></div>
<img src="/img/icon.png" alt="tiny icon" style="width:16px">
<img src="/noext/photo123" alt="No extension">
<img src="/dl/named" alt="Server-named">
<img src="/protected/p.png" alt="Hotlink protected">
<p><a href="/files/report.pdf">Annual report</a> · <a href="/files/pack.zip">Asset pack</a></p>
<video src="/media/clip.mp4" poster="/img/poster.png" width="320" muted></video>
<div id="more"></div><div style="height:3000px"></div>
<script>
let batch = 0;
addEventListener('scroll', () => {
  if (batch >= 3) return;
  if (innerHeight + scrollY < document.documentElement.scrollHeight - 400) return;
  batch++;
  for (let i = 0; i < 4; i++) { const im = new Image(); im.src = '/scroll/' + batch + '-' + i + '.png'; im.alt = 'scroll ' + batch; document.getElementById('more').appendChild(im); }
  document.body.appendChild(Object.assign(document.createElement('div'), { style: 'height:1500px' }));
});
</script></body></html>`;
}

function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const base = `http://${req.headers.host}`;
      const u = new URL(req.url, base);
      const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, ...extra }); res.end(body); };
      if (u.pathname === '/gallery.html') return send(200, 'text/html', Buffer.from(page(base)));
      let m;
      if ((m = /^\/img\/(.+)$/.exec(u.pathname)) && IMAGES[m[1]]) {
        const [w, h, c] = IMAGES[m[1]];
        return send(200, m[1].endsWith('.jpg') ? 'image/jpeg' : 'image/png', png(m[1], w, h, c));
      }
      if ((m = /^\/scroll\/(\d)-(\d)\.png$/.exec(u.pathname))) return send(200, 'image/png', png(u.pathname, 700, 500, [90 + m[1] * 40, 60, 200 - m[2] * 30]));
      if (u.pathname === '/noext/photo123') return send(200, 'image/png', png('noext', 400, 300, [30, 160, 170]));
      if (u.pathname === '/dl/named') return send(200, 'image/png', png('named', 420, 280, [160, 160, 40]), { 'Content-Disposition': 'inline; filename="server-name.png"' });
      if (u.pathname === '/protected/p.png') {
        const ref = req.headers.referer || '';
        if (!ref.startsWith(base)) return send(403, 'text/plain', Buffer.from('hotlinking not allowed'));
        return send(200, 'image/png', png('prot', 500, 500, [210, 60, 60]));
      }
      if (u.pathname === '/files/report.pdf') return send(200, 'application/pdf', Buffer.from('%PDF-1.4\n% test file\n'));
      if (u.pathname === '/files/pack.zip') return send(200, 'application/zip', Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'));
      if (u.pathname === '/media/clip.mp4') return send(200, 'video/mp4', Buffer.alloc(1024));
      send(404, 'text/plain', Buffer.from('not found'));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = { start };
