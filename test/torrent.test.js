'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
// The download folder in the form the system uses: a drive path on Windows, where the app runs.
const DL = process.platform === 'win32' ? 'D:\\dl' : '/dl';
const { encode, decode, torrentInfo, parseMagnet } = require('../src/main/torrent/bencode');
const { Aria2, parseTrackers } = require('../src/main/torrent/aria2');
const { TorrentDownload } = require('../src/main/download/torrent-dl');

function makeTorrent(multi) {
  const info = multi
    ? { name: 'Holiday photos', 'piece length': 16384, pieces: Buffer.alloc(20), files: [{ length: 1000, path: ['a.jpg'] }, { length: 2500, path: ['sub', 'b.mp4'] }] }
    : { name: 'ubuntu.iso', 'piece length': 16384, pieces: Buffer.alloc(20), length: 4096 };
  return { buf: encode({ announce: 'udp://tracker.example:1337/announce', 'announce-list': [['udp://tracker.example:1337/announce'], ['https://t2.example/announce']], info }), info };
}

test('torrent files: name, files, size and info hash', () => {
  const { buf, info } = makeTorrent(true);
  const t = torrentInfo(buf);
  assert.equal(t.name, 'Holiday photos');
  assert.deepEqual(t.files, [{ path: 'a.jpg', length: 1000 }, { path: 'sub/b.mp4', length: 2500 }]);
  assert.equal(t.length, 3500);
  assert.equal(t.infoHash, crypto.createHash('sha1').update(encode(info)).digest('hex'));
  assert.deepEqual(t.trackers, ['udp://tracker.example:1337/announce', 'https://t2.example/announce']);
  assert.equal(torrentInfo(makeTorrent(false).buf).files[0].path, 'ubuntu.iso');
  assert.deepEqual(decode(encode({ x: [1, 'two', { y: 3 }] })).x[1].toString(), 'two');
  assert.throws(() => torrentInfo(Buffer.from('not a torrent')));
});

test('magnet links (hex and base32) and tracker lists', () => {
  const hex = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  assert.deepEqual(parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ft.example%3A80`), { infoHash: hex, name: 'Big Buck Bunny', trackers: ['udp://t.example:80'] });
  assert.equal(parseMagnet('magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK').infoHash, hex);
  assert.equal(parseMagnet('https://example.com'), null);
  assert.deepEqual(parseTrackers('udp://a.example:80/announce\n\nhttps://b.example/announce\nnot-a-url\nudp://a.example:80/announce'), ['udp://a.example:80/announce', 'https://b.example/announce']);
});

// A stand-in for aria2's JSON-RPC: downloads move forward each time their status is read.
function mockAria2(t, { seedPolls = 2, name = 'ubuntu.iso' } = {}) {
  const calls = [];
  const dl = new Map();
  let n = 0;
  const gid = () => (++n).toString(16).padStart(16, '0');
  const status = (d) => ({
    gid: d.gid, status: d.status, totalLength: String(d.total), completedLength: String(d.done), uploadLength: String(d.up),
    downloadSpeed: d.status === 'active' && d.done < d.total ? '500000' : '0', uploadSpeed: d.seeder ? '20000' : '0',
    connections: '7', numSeeders: '3', seeder: d.seeder ? 'true' : 'false', infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    followedBy: d.followedBy, bittorrent: d.meta ? undefined : { info: { name: d.name } }, dir: DL,
    files: d.meta ? [] : [{ index: '1', path: path.join(DL, d.name), length: String(d.total), completedLength: String(d.done), selected: 'true' }],
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const [token, ...p] = j.params;
      const method = j.method.replace('aria2.', '');
      calls.push([method, p]);
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      const fail = (code, message) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code, message } }));
      if (token !== 'token:s3cret') return fail(1, 'Unauthorized');
      const d = dl.get(p[0]);
      switch (method) {
        case 'getVersion': return reply({ version: '1.37.0' });
        case 'addUri': {
          const meta = { gid: gid(), meta: true, status: 'active', total: 0, done: 0, up: 0, polls: 0 };
          dl.set(meta.gid, meta);
          if (p[0][0].includes('broken')) meta.broken = true;
          return reply(meta.gid);
        }
        case 'addTorrent': {
          const d2 = { gid: gid(), name, status: p[2] && p[2].pause === 'true' ? 'paused' : 'active', total: 4096, done: 0, up: 0, select: (p[2] || {})['select-file'] || '' };
          dl.set(d2.gid, d2);
          return reply(d2.gid);
        }
        case 'tellStatus': {
          if (d.broken) { d.status = 'error'; return reply({ ...status(d), errorCode: '3', errorMessage: 'Resource not found' }); }
          if (d.meta && d.status === 'active') {
            const child = { gid: gid(), name: 'Holiday photos', status: 'paused', total: 3500, done: 0, up: 0, select: '' };
            dl.set(child.gid, child);
            d.status = 'complete'; d.followedBy = [child.gid];
          } else if (d.status === 'active') {
            if (d.done < d.total) d.done = Math.min(d.total, d.done + Math.ceil(d.total * 0.4));
            else if (!d.seeder) { d.seeder = true; d.seedLeft = seedPolls; } else { d.up += 500; if (--d.seedLeft <= 0) d.status = 'complete'; }
            if (d.done >= d.total && !d.seeder) { d.seeder = true; d.seedLeft = seedPolls; }
          }
          return reply(status(d));
        }
        case 'getFiles': return reply([
          { index: '1', path: path.join(DL, 'Holiday photos', 'a.jpg'), length: '1000', completedLength: '0', selected: 'true' },
          { index: '2', path: path.join(DL, 'Holiday photos', 'sub', 'b.mp4'), length: '2500', completedLength: '0', selected: 'true' },
        ]);
        case 'changeOption': d.select = p[1]['select-file']; d.total = d.select === '2' ? 2500 : d.total; return reply('OK');
        case 'unpause': d.status = 'active'; return reply(p[0]);
        case 'forcePause': d.status = 'paused'; return reply(p[0]);
        case 'forceRemove': d.status = 'removed'; return reply(p[0]);
        case 'removeDownloadResult': return reply('OK');
        default: return fail(1, 'No such method: ' + method);
      }
    });
  });
  t.after(() => server.close());
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, calls, dl })));
}

const ariaFor = (port) => new Aria2({ settings: { get: () => undefined }, userDataDir: 'x', rpcPort: port, secret: 's3cret' });
const runToDone = (td) => new Promise((res, rej) => { td.on('done', res); td.on('error', rej); td.start(); });

test('a magnet link: torrent info, the user picks files, download, seeding until the limit', async (t) => {
  const { port, calls } = await mockAria2(t);
  const aria2 = ariaFor(port);
  assert.equal((await aria2.status()).version, '1.37.0');
  let offered = null;
  const td = new TorrentDownload({ id: 'm', aria2, magnet: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a', dir: DL, pollMs: 20,
    askFiles: async (files) => { offered = files; return '2'; } });
  const gids = [];
  let renamed = '';
  td.on('gid', (g) => gids.push(g));
  td.on('renamed', (p) => { renamed = p; });
  const seeding = [];
  td.on('seeding', (s) => seeding.push(s));
  await runToDone(td);
  assert.deepEqual(offered.map((f) => [f.index, f.path.replace(/\\/g, '/'), f.length]), [[1, 'a.jpg', 1000], [2, 'sub/b.mp4', 2500]]);
  assert.ok(calls.some(([m, p]) => m === 'changeOption' && p[1]['select-file'] === '2'), 'only the chosen file');
  assert.equal(gids.length, 2, 'metadata download, then the real one');
  assert.match(renamed, /Holiday photos$/);
  assert.equal(td.progress().received, 2500);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(seeding.length >= 1 && seeding[0].uploadSpeed > 0, 'seeding reported after completion');
  assert.equal(calls.filter(([m]) => m === 'tellStatus').length > 0, true);
});

test('a .torrent with files already chosen starts right away; cancel and errors', async (t) => {
  const { port, calls } = await mockAria2(t);
  const aria2 = ariaFor(port);
  const td = new TorrentDownload({ id: 't', aria2, torrent: makeTorrent(false).buf.toString('base64'), dir: DL, selectFiles: '1', pollMs: 20 });
  await runToDone(td);
  const add = calls.find(([m]) => m === 'addTorrent');
  assert.equal(add[1][2].pause, undefined, 'not paused');
  assert.equal(add[1][2]['select-file'], '1');

  const cancelled = new TorrentDownload({ id: 'c', aria2, magnet: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a', dir: DL, pollMs: 20, askFiles: async () => null });
  const err = await new Promise((r) => { cancelled.on('error', r); cancelled.on('done', () => r(null)); cancelled.start(); });
  assert.equal(err.code, 'CANCELLED');
  assert.ok(calls.some(([m]) => m === 'forceRemove'));

  const broken = new TorrentDownload({ id: 'b', aria2, magnet: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=broken', dir: DL, pollMs: 20 });
  const e2 = await new Promise((r) => { broken.on('error', r); broken.on('done', () => r(null)); broken.start(); });
  assert.match(e2.message, /Resource not found/);

  const wrong = new Aria2({ settings: { get: () => undefined }, userDataDir: 'x', rpcPort: port, secret: 'wrong' });
  await assert.rejects(wrong.call('getVersion'), /Unauthorized/);
});

test('AU-01: a torrent whose name leads out of the download folder is not moved there', async (t) => {
  const { port } = await mockAria2(t, { name: path.join('..', '..', 'Documents') });
  const td = new TorrentDownload({ id: 'e', aria2: ariaFor(port), torrent: makeTorrent(false).buf.toString('base64'), dir: DL, selectFiles: '1', pollMs: 20 });
  const renamed = []; const paths = [];
  td.on('renamed', (p) => renamed.push(p)); td.on('paths', (p) => paths.push(...p));
  await runToDone(td);
  await td.cancel();
  assert.deepEqual(renamed, []);
  assert.deepEqual(paths, [], 'a file outside the folder is never listed for deleting');
});

test('AU-02: cancelling a torrent deletes only its own files, and the same torrent is found as a duplicate', async () => {
  const fs = require('fs'); const os = require('os');
  const { removeTorrentFiles, DownloadManager } = require('../src/main/download/manager');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-bt-'));
  const folder = path.join(dir, 'Holiday photos');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  for (const f of ['a.jpg', path.join('sub', 'b.mp4'), 'mine.txt']) fs.writeFileSync(path.join(folder, f), 'x');
  fs.writeFileSync(folder + '.aria2', 'x');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'x');
  removeTorrentFiles({ savePath: folder, btPaths: [path.join(folder, 'a.jpg'), path.join(folder, 'sub', 'b.mp4'), path.join(dir, 'outside.txt'), path.join(dir, '..', 'x')] });
  assert.deepEqual(fs.readdirSync(folder), ['mine.txt'], "the user's own file stays, the empty sub folder goes");
  assert.ok(fs.existsSync(path.join(dir, 'outside.txt')), 'nothing outside the torrent folder is deleted');
  assert.ok(!fs.existsSync(folder + '.aria2'));

  const first = { id: '1', kind: 'torrent', infoHash: 'c12f', state: 'downloading', sources: [], savePath: folder };
  const m = { records: new Map([['1', first]]) };
  assert.equal(DownloadManager.prototype.findDuplicate.call(m, { kind: 'torrent', infoHash: 'C12F', magnet: 'magnet:?xt=urn:btih:c12f' }), first);
  assert.equal(DownloadManager.prototype.findDuplicate.call(m, { kind: 'torrent', infoHash: 'ffff' }), null);
  let resumed = null;
  const fake = (running) => ({ findDuplicate: () => first, resume: (id) => { resumed = id; }, engines: new Map(running ? [['1', {}]] : []) });
  const add = (spec, running) => DownloadManager.prototype.add.call(fake(running), { kind: 'torrent', infoHash: 'c12f', ...spec });
  assert.equal(add({}, true), first, 'adding the same torrent again gives the existing record');
  assert.equal(resumed, null, 'a running one is not started twice');
  first.state = 'paused';
  add({ start: false }); assert.equal(resumed, null, '"Add paused" leaves it paused');
  first.state = 'done';
  add({}); assert.equal(resumed, '1', 'a finished one added again is checked and completed again');
  assert.equal(first.state, 'paused');
  const q = { records: new Map([['1', { id: '1', state: 'downloading' }]]), engines: new Map([['1', {}]]), queue: [] };
  DownloadManager.prototype.enqueue.call(q, '1');
  assert.deepEqual(q.queue, [], 'enqueue skips a record that is running');
});
