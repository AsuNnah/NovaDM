'use strict';
// In-app self-test for torrents (0.6.0), with a stand-in for aria2's JSON-RPC (the real aria2 is
// tested separately when installed): magnet link clicked in a page -> dialog -> details -> file
// choice -> download -> seeding -> Stop seeding; a .torrent link with one file unticked; the
// message when aria2 is not installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Aria2 } = require('../src/main/torrent/aria2');
const { encode } = require('../src/main/torrent/bencode');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase5.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

function fakeAria2() {
  const calls = [];
  const dl = new Map();
  let n = 0;
  const gid = () => (++n).toString(16).padStart(16, '0');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const [, ...p] = j.params;
      const m = j.method.replace('aria2.', '');
      calls.push([m, p]);
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      const d = dl.get(p[0]);
      if (m === 'getVersion') return reply({ version: '1.37.0' });
      if (m === 'addUri') { const g = gid(); dl.set(g, { gid: g, meta: true, status: 'active', total: 0, done: 0, up: 0 }); return reply(g); }
      if (m === 'addTorrent') { const g = gid(); dl.set(g, { gid: g, name: 'Two files', status: p[2] && p[2].pause === 'true' ? 'paused' : 'active', total: 3000, done: 0, up: 0, select: (p[2] || {})['select-file'] }); return reply(g); }
      if (m === 'tellStatus') {
        if (d.meta && d.status === 'active') { const g = gid(); dl.set(g, { gid: g, name: 'Holiday photos', status: 'paused', total: 3500, done: 0, up: 0 }); d.status = 'complete'; d.followedBy = [g]; }
        else if (d.status === 'active') { if (d.done < d.total) d.done = Math.min(d.total, d.done + 900); else { d.seeder = true; d.up += 400; } }
        return reply({ gid: d.gid, status: d.status, totalLength: String(d.total), completedLength: String(d.done), uploadLength: String(d.up), downloadSpeed: d.done < d.total ? '900000' : '0', uploadSpeed: d.seeder ? '40000' : '0', connections: '5', numSeeders: '2', seeder: d.seeder ? 'true' : 'false', infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a', followedBy: d.followedBy, bittorrent: d.meta ? undefined : { info: { name: d.name } }, dir: 'X:\\' });
      }
      if (m === 'getFiles') return reply([{ index: '1', path: 'X:\\Holiday photos\\a.jpg', length: '1000', completedLength: '0', selected: 'true' }, { index: '2', path: 'X:\\Holiday photos\\b.mp4', length: '2500', completedLength: '0', selected: 'true' }]);
      if (m === 'changeOption') { d.select = p[1]['select-file']; if (d.select === '2') d.total = 2500; return reply('OK'); }
      if (m === 'unpause') { d.status = 'active'; return reply(p[0]); }
      if (['forcePause', 'forceRemove'].includes(m)) { d.status = m === 'forcePause' ? 'paused' : 'removed'; return reply(p[0]); }
      return reply('OK');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, calls })));
}

module.exports = async ({ app, browser, downloads, settings, overlayView, ipc }) => {
  const result = {};
  const overlayText = () => overlayView.webContents.executeJavaScript('document.getElementById("content").innerText');
  const click = (sel) => overlayView.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
  try {
    const torrent = encode({ info: { name: 'Two files', 'piece length': 16384, pieces: Buffer.alloc(20), files: [{ length: 1000, path: ['one.txt'] }, { length: 2000, path: ['two.mkv'] }] } });
    const page = http.createServer((req, res) => {
      if (req.url === '/two.torrent') { res.writeHead(200, { 'Content-Type': 'application/x-bittorrent', 'Content-Disposition': 'attachment; filename="two.torrent"' }); return res.end(torrent); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Linux images</title><a id="mag" href="magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Holiday+photos">magnet</a> <a id="tor" href="/two.torrent">torrent</a>');
    });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${page.address().port}`;
    const dlDir = path.join(app.getPath('userData'), 'dl-phase5');
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: false, notifyOnComplete: false, torrentAskFiles: true });

    // aria2 not installed: a clear error on the download.
    downloads.add({ kind: 'torrent', magnet: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=No+aria2', name: 'No aria2' });
    const missing = await until(() => downloads.list().find((d) => d.name === 'No aria2' && d.state === 'error'), 5000);
    result.withoutAria2 = missing ? { error: missing.error, code: missing.errorCode } : null;
    if (missing) await downloads.cancel(missing.id, false);

    const fake = await fakeAria2();
    downloads.aria2 = new Aria2({ settings, userDataDir: app.getPath('userData'), rpcPort: fake.port, secret: 'x' });
    // Faster polling for the test.
    const { TorrentDownload } = require('../src/main/download/torrent-dl');
    const origPoll = TorrentDownload.prototype.poll;
    TorrentDownload.prototype.poll = function poll() { this.pollMs = 100; return origPoll.call(this); };

    // 1. Magnet link in a page.
    const tabId = browser.createTab({ url: base + '/' });
    const tab = browser.tabs.get(tabId);
    await until(() => !tab.wc.isLoading(), 5000);
    await tab.wc.executeJavaScript('document.getElementById("mag").click()');
    const ask = await until(async () => { const t = await overlayText(); return /New download/.test(t) && t; }, 6000);
    result.magnetDialog = { shown: !!ask, explainsFiles: !!ask && /choose the files/i.test(ask) };
    await click('#na-go');
    const choose = await until(async () => { const t = await overlayText(); return /Choose files/.test(t) && t; }, 8000);
    result.fileChooser = { shown: !!choose, lists: !!choose && /a\.jpg/.test(choose) && /b\.mp4/.test(choose) };
    await overlayView.webContents.executeJavaScript('document.querySelector("#tf-files input[data-i=\\"0\\"]").click()'); // untick a.jpg
    await click('.acts .btn.pri');
    const mag = await until(() => downloads.list().find((d) => d.kind === 'torrent' && d.state === 'done' && d.seeding), 15000);
    result.magnet = mag ? { name: mag.name, size: mag.size, seeding: mag.seeding, selected: downloads.get(mag.id).selectFiles } : downloads.list().filter((d) => d.kind === 'torrent').map((d) => [d.name, d.state, d.phase, d.error]);
    if (mag) {
      await ipc['downloads.stopSeeding']({ id: mag.id });
      result.stopSeeding = { seeding: downloads.list().find((d) => d.id === mag.id).seeding, removed: fake.calls.some(([m]) => m === 'forceRemove') };
    }

    // 2. A .torrent link: the dialog lists its files; one is unticked.
    await tab.wc.executeJavaScript('document.getElementById("tor").click()');
    const tdlg = await until(async () => { const t = await overlayText(); return /two\.mkv/.test(t) && t; }, 8000);
    result.torrentDialog = { shown: !!tdlg, files: !!tdlg && /one\.txt/.test(tdlg) };
    await overlayView.webContents.executeJavaScript('document.querySelector("#na-files input[data-i=\\"0\\"]").click()');
    await click('#na-go');
    const add = await until(() => fake.calls.find(([m]) => m === 'addTorrent'), 8000);
    result.torrentAdded = add ? { selectFile: add[1][2]['select-file'], paused: add[1][2].pause || '' } : null;
    const tdone = await until(() => downloads.list().find((d) => d.name === 'Two files' && d.state === 'done'), 15000);
    result.torrentDone = !!tdone;
    page.close(); fake.server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
