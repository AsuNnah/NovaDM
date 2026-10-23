'use strict';
// 1.7.5: issue 33 (private addresses), issue 34 (huge or deeply nested bookmark files).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPrivateIp, isPrivateUrl, guardFor } = require('../src/main/netguard');
const { Bookmarks, parseHtml, MAX_DEPTH } = require('../src/main/bookmarks');
const { fromChromiumJson } = require('../src/main/bookmarks-import');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-175-'));

test('netguard: which addresses are private', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '64:ff9b::10.0.0.1', '[::1]']) assert.strictEqual(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', 'example.com']) assert.strictEqual(isPrivateIp(ip), false, ip);
});

test('netguard: addresses and names in a URL', async () => {
  const lookup = async (h) => ({ 'public.example': [{ address: '93.184.216.34' }], 'rebind.example': [{ address: '93.184.216.34' }, { address: '10.1.2.3' }], 'v6.example': [{ address: '2606:4700::1' }] }[h] || (() => { throw new Error('ENOTFOUND'); })());
  const priv = (u) => isPrivateUrl(u, { lookup });
  assert.strictEqual(await priv('http://127.0.0.1:8080/x'), true);
  assert.strictEqual(await priv('http://[::1]/x'), true);
  assert.strictEqual(await priv('http://192.168.0.1/'), true);
  assert.strictEqual(await priv('http://localhost/'), true);
  assert.strictEqual(await priv('http://printer.local/'), true);
  assert.strictEqual(await priv('http://nas/'), true); // a bare name is on the local network
  assert.strictEqual(await priv('http://public.example/'), false);
  assert.strictEqual(await priv('http://v6.example/'), false);
  assert.strictEqual(await priv('http://rebind.example/'), true); // any private answer counts
  assert.strictEqual(await priv('http://nothing-here.example/'), false); // can't be looked up: the request fails by itself
  assert.strictEqual(await priv('not a url'), false);
});

test('netguard: a page on the internet cannot reach private addresses; a local page can', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }];
  const fromWeb = guardFor('https://video.example/watch', { lookup });
  await fromWeb('https://cdn.example/a.m3u8'); // public to public: fine
  await assert.rejects(fromWeb('http://127.0.0.1:9614/api/v1/status'), /Not fetched/);
  await assert.rejects(fromWeb('http://192.168.1.1/admin'), /Not fetched/);
  await assert.rejects(fromWeb('http://[fe80::1]/'), /Not fetched/);
  await assert.rejects(guardFor('', { lookup })('http://10.0.0.1/'), /Not fetched/); // no page known: treated as the internet
  const fromHome = guardFor('http://192.168.1.20:8096/web/index.html', { lookup }); // a media server at home
  await fromHome('http://192.168.1.20:8096/hls/master.m3u8');
  await fromHome('http://127.0.0.1:1/');
});

test('bookmark import: folders nested thousands deep do not use up the stack, and stop at the depth limit', () => {
  const b = new Bookmarks(tmp());
  // 30,000 folders inside each other, built without recursion, a link at every level.
  let tree = { title: 'bottom', children: [{ title: 'deep', url: 'https://deep.example/' }] };
  for (let i = 0; i < 30000; i++) tree = { title: 'f' + i, children: [tree, { title: 'l' + i, url: `https://l${i}.example/` }] };
  const r = b.importTree({ bar: [tree], other: [] });
  const folders = b.nodes.filter((n) => n.type === 'folder');
  assert.ok(folders.length <= MAX_DEPTH + 1, `folders: ${folders.length}`);
  assert.ok(r.added >= MAX_DEPTH - 1 && r.added < 200, `added: ${r.added}`);
  assert.ok(r.skipped >= 1);
  // The tree it made is shallow enough to export and read back.
  const again = new Bookmarks(tmp());
  assert.ok(again.importHtml(b.exportHtml()).added >= 1);
});

test('bookmark import: files with nesting thousands deep (Chrome file, HTML) are cut off, not crashed on', () => {
  const N = 20000;
  const chrome = '{"roots":{"bookmark_bar":{"type":"folder","name":"bar","children":[' + '{"type":"folder","name":"f","children":['.repeat(N) + '{"type":"url","name":"x","url":"https://x.example/"}' + ']}'.repeat(N) + ']}}}';
  const tree = fromChromiumJson(chrome);
  let depth = 0; for (let n = tree.bar[0]; n && n.children; n = n.children[0]) depth++;
  assert.ok(depth <= MAX_DEPTH + 1, `depth ${depth}`);
  const html = '<DL><p>' + '<DT><H3>f</H3><DL><p>'.repeat(N) + '<DT><A HREF="https://y.example/">y</A>' + '</DL><p>'.repeat(N) + '</DL>';
  const b = new Bookmarks(tmp());
  assert.doesNotThrow(() => b.importTree(parseHtml(html)));
  assert.ok(b.nodes.filter((n) => n.type === 'folder').length <= MAX_DEPTH + 1);
});

test('bookmark import: a large file is quick, and a second import adds nothing', () => {
  const b = new Bookmarks(tmp());
  const bar = Array.from({ length: 60000 }, (_, i) => ({ title: 'b' + i, url: `https://site${i}.example/page` }));
  bar.push({ title: 'F', children: Array.from({ length: 20000 }, (_, i) => ({ title: 'c' + i, url: `https://other${i}.example/` })) });
  const t0 = Date.now();
  assert.deepStrictEqual(b.importTree({ bar, other: [] }), { added: 80000, skipped: 0 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.deepStrictEqual(b.importTree({ bar, other: [] }), { added: 0, skipped: 80000 });
  assert.strictEqual(b.nodes.filter((n) => n.type === 'folder').length, 1); // "F" merged, not repeated
  // Bad entries are skipped, not fatal.
  assert.deepStrictEqual(b.importTree({ bar: [null, { title: 'n' }, { title: 'js', url: 'javascript:alert(1)' }, { children: 'x', title: 'odd' }, { title: 'ok', url: 'https://ok.example/' }], other: [] }), { added: 1, skipped: 4 });
});
