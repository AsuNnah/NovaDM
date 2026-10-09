'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { parseCurl } = require('../src/main/curl');
const { exportData, importData } = require('../src/main/backup');
const { categoryFor, siteSettingsFor } = require('../src/main/rules');
const { buildArgs, runProgram, sendWebhook } = require('../src/main/hooks');
const { extractArchive, isArchive } = require('../src/main/download/postprocess');
const { LocalApi } = require('../src/main/api');

test('cURL commands from the browser (bash and Windows forms)', () => {
  const bash = `curl 'https://cdn.example.com/f.zip?t=1' \\
  -H 'accept: */*' \\
  -H 'referer: https://example.com/page' \\
  -b 'sid=abc; theme=dark' \\
  -H 'user-agent: Mozilla/5.0' \\
  -H 'accept-encoding: gzip' \\
  --compressed`;
  const r = parseCurl(bash);
  assert.equal(r.url, 'https://cdn.example.com/f.zip?t=1');
  assert.deepEqual(r.headers, { accept: '*/*', referer: 'https://example.com/page', cookie: 'sid=abc; theme=dark', 'user-agent': 'Mozilla/5.0' });
  const cmd = 'curl ^"https://cdn.example.com/a b.mp4^" ^\n  -H ^"referer: https://example.com/^" ^\n  -H ^"cookie: x=1^"';
  const w = parseCurl(cmd);
  assert.equal(w.url, 'https://cdn.example.com/a b.mp4');
  assert.deepEqual(w.headers, { referer: 'https://example.com/', cookie: 'x=1' });
  assert.throws(() => parseCurl("curl 'https://x.example/api' --data-raw '{}'"), /POST/);
  assert.throws(() => parseCurl('wget https://x.example/f'), /curl/);
});

test('export leaves out secrets and cookies; import adds what is new', () => {
  const store = { downloadDir: 'D:\\dl', apiKey: 'secret', proxyPassEnc: 'enc', ffmpegPath: 'C:\\x\\ffmpeg.exe', siteSettings: [{ site: 'a.example', user: 'me', passEnc: 'enc2' }] };
  const settings = { data: store, set: (p) => { Object.assign(store, p); return p; } };
  const recs = new Map([
    ['1', { kind: 'http', name: 'f.zip', savePath: 'D:\\dl\\f.zip', sources: ['https://a.example/f.zip'], headers: { referer: 'https://a.example/', cookie: 'sid=1' }, state: 'done', size: 10 }],
    ['2', { kind: 'hls', name: 'v.mp4', savePath: 'D:\\dl\\v.mp4', playlistUrl: 'https://a.example/v.m3u8', headers: {}, state: 'downloading', size: -1 }],
    ['3', { kind: 'http', name: 'p.zip', savePath: 'D:\\dl\\p.zip', sources: ['https://a.example/p.zip'], headers: {}, state: 'done', incognito: true }],
  ]);
  const data = exportData({ settings, downloads: { records: recs }, version: '0.8.0' });
  const text = JSON.stringify(data);
  assert.ok(!/secret|"enc"|enc2|sid=1|ffmpeg\.exe/.test(text), 'no key, passwords, cookies or this PC\u2019s paths');
  assert.equal(data.downloads.length, 2, 'private-tab downloads are not exported');
  assert.equal(data.downloads[1].state, 'paused', 'unfinished ones come back paused');

  const added = [];
  const target = { records: new Map([['x', { kind: 'http', sources: ['https://a.example/f.zip'], savePath: 'D:\\dl\\f.zip' }]]), importRecord: (d) => added.push(d) };
  const st2 = { set: (p) => p };
  const r = importData(data, { settings: st2, downloads: target });
  assert.deepEqual([r.added, r.skipped], [1, 1], 'the one already in the list is skipped');
  assert.equal(added[0].name, 'v.mp4');
  assert.throws(() => importData({ app: 'Other' }, { settings: st2, downloads: target }), /not a NovaDM/);
});

test('category rules and per-site settings', () => {
  const rules = [
    { by: 'type', value: 'psd ai', category: 'images', folder: 'D:\\Design' },
    { by: 'site', value: 'lectures.example.edu', category: 'video', folder: '' },
    { by: 'text', value: '/invoices/', category: 'documents', folder: 'D:\\Invoices' },
  ];
  assert.deepEqual(categoryFor(rules, { url: 'https://x.example/a/logo.PSD', name: 'logo.PSD' }), { category: 'images', folder: 'D:\\Design' });
  assert.deepEqual(categoryFor(rules, { url: 'https://cdn.lectures.example.edu/w1.bin', name: 'w1.bin' }), { category: 'video', folder: '' });
  assert.deepEqual(categoryFor(rules, { url: 'https://shop.example/invoices/42.pdf', name: '42.pdf' }), { category: 'documents', folder: 'D:\\Invoices' });
  assert.deepEqual(categoryFor(rules, { url: 'https://x.example/a.zip', name: 'a.zip' }), { category: '', folder: '' });
  const sites = [{ site: 'files.example.com', connections: 2 }, { site: '*.slow.example', speedLimitKBps: 100 }];
  assert.equal(siteSettingsFor(sites, 'https://files.example.com/x').connections, 2);
  assert.equal(siteSettingsFor(sites, 'https://a.b.slow.example/x').speedLimitKBps, 100);
  assert.equal(siteSettingsFor(sites, 'https://example.com/x'), null);
});

test('after-download program: placeholders stay single arguments; no shell, no batch files', async () => {
  const rec = { savePath: 'D:\\dl\\a & calc.exe "x".zip', name: 'a & calc.exe "x".zip', sources: ['https://a.example/f'], pageUrl: '' };
  assert.deepEqual(buildArgs('--open "{file}" --from {url}', rec), ['--open', 'D:\\dl\\a & calc.exe "x".zip', '--from', 'https://a.example/f']);
  let spawned = null;
  const fake = (prog, args, opts) => { spawned = { prog, args, opts }; const ee = new (require('events'))(); setImmediate(() => ee.emit('spawn')); ee.unref = () => {}; return ee; };
  assert.deepEqual(await runProgram('C:\\Tools\\viewer.exe', '"{file}"', rec, fake), { ok: true });
  assert.equal(spawned.opts.shell, false);
  assert.deepEqual(spawned.args, ['D:\\dl\\a & calc.exe "x".zip']);
  assert.equal((await runProgram('C:\\x\\run.bat', '', rec, fake)).ok, false);
});

test('webhook gets a JSON note', async (t) => {
  let got = null;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = JSON.parse(b); res.end('ok'); }); });
  t.after(() => server.close());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await sendWebhook(`http://127.0.0.1:${server.address().port}/hook`, 'finished', { name: 'f.zip', savePath: 'D:\\dl\\f.zip', size: 10, sources: ['https://a.example/f.zip'], pageUrl: 'https://a.example/' });
  assert.equal(r.ok, true);
  assert.deepEqual([got.event, got.name, got.url, got.app], ['finished', 'f.zip', 'https://a.example/f.zip', 'NovaDM']);
  assert.equal((await sendWebhook('file:///x', 'finished', {})).ok, false);
});

test('archives are unpacked into a folder next to them', { skip: process.platform !== 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-zip-'));
  fs.mkdirSync(path.join(tmp, 'src', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'readme.txt'), 'hello');
  fs.writeFileSync(path.join(tmp, 'src', 'docs', 'a.txt'), 'a');
  const zip = path.join(tmp, 'Pack.zip');
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', path.join(tmp, 'src'), 'readme.txt', 'docs']);
  assert.equal(isArchive(zip), true);
  assert.equal(isArchive('movie.mp4'), false);
  const r = await extractArchive(zip);
  assert.equal(r.ok, true);
  assert.equal(r.folder, path.join(tmp, 'Pack'));
  assert.equal(fs.readFileSync(path.join(r.folder, 'docs', 'a.txt'), 'utf8'), 'a');
  const again = await extractArchive(zip);
  assert.equal(again.folder, path.join(tmp, 'Pack (1)'), 'never into an existing folder');
  const bad = path.join(tmp, 'broken.zip');
  fs.writeFileSync(bad, 'not a zip');
  assert.equal((await extractArchive(bad)).ok, false);
});

test('MCP: AI assistants can list tools and add downloads with the key', async (t) => {
  const store = { apiEnabled: true, apiPort: 0, apiKey: 'mcpkey' };
  const calls = [];
  const api = new LocalApi({
    settings: { get: (k) => store[k], set: (p) => Object.assign(store, p) },
    downloads: { add: (s) => { calls.push(s); return { id: 'n1' }; }, list: () => [{ id: 'n1', name: 'f.zip', state: 'done', percent: 100, size: 10, speed: 0 }], get: (id) => (id === 'n1' ? { id } : null), activeSummary: () => ({ active: 0 }), pause: () => calls.push('pause') },
    addFlow: { request: () => ({ pending: true }) }, version: '0.8.0',
  });
  t.after(() => api.stop());
  const { port } = await api.update();
  const rpc = (body, key = 'mcpkey') => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', authorization: `Bearer ${key}` } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.end(data);
  });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'wrong')).status, 401);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.body.result.serverInfo.name, 'NovaDM');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.body.result.tools.map((x) => x.name), ['add_download', 'list_downloads', 'get_status', 'pause_download', 'resume_download', 'remove_download']);
  const add = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_download', arguments: { url: 'https://a.example/f.zip', start: true } } });
  assert.equal(add.body.result.isError, false);
  assert.equal(calls[0].url, 'https://a.example/f.zip');
  const list = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_downloads', arguments: {} } });
  assert.match(list.body.result.content[0].text, /f\.zip/);
  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pause_download', arguments: { id: 'nope' } } });
  assert.equal(bad.body.result.isError, true);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'nope' })).body.error.code, -32601);
});
