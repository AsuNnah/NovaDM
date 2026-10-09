'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SiteExtensions, matchPattern, readManifest, cleanItems } = require('../src/main/site-ext');

test('site patterns', () => {
  assert.equal(matchPattern('https://*.example.com/*', 'https://www.example.com/a?b=1'), true);
  assert.equal(matchPattern('https://*.example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('https://*.example.com/*', 'https://badexample.com/'), false);
  assert.equal(matchPattern('https://*.example.com/*', 'http://www.example.com/'), false, 'scheme');
  assert.equal(matchPattern('*://videos.example.org/watch*', 'http://videos.example.org/watch?v=1'), true);
  assert.equal(matchPattern('*://videos.example.org/watch*', 'https://videos.example.org/about'), false);
  assert.equal(matchPattern('https://a.example/*', 'file:///C:/x'), false);
});

function extFolder(manifest, script = 'novadm.onResolve(() => [])') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-se-'));
  fs.writeFileSync(path.join(dir, 'novadm-extension.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), script);
  return dir;
}

test('manifests: a name, specific sites and the script are required', () => {
  assert.equal(readManifest(extFolder({ name: 'A', matches: ['https://a.example/*'] })).script, 'index.js');
  assert.throws(() => readManifest(extFolder({ matches: ['https://a.example/*'] })), /no name/);
  assert.throws(() => readManifest(extFolder({ name: 'A' })), /which sites/);
  assert.throws(() => readManifest(extFolder({ name: 'A', matches: ['*://*/*'] })), /every site/);
  assert.throws(() => readManifest(extFolder({ name: 'A', matches: ['https://a.example/*'], script: '../evil.js' })), /missing/);
});

test('what an extension hands back is cleaned', () => {
  const items = cleanItems([
    { url: 'https://a.example/v.m3u8', name: 'Clip' },
    { url: 'javascript:alert(1)' },
    { url: 'https://a.example/f.zip', kind: 'weird', headers: { Referer: 'https://a.example/', Cookie: 'steal', 'X-Token': 't' } },
    'nonsense',
  ]);
  assert.deepEqual(items.map((i) => [i.kind, i.url]), [['hls', 'https://a.example/v.m3u8'], ['file', 'https://a.example/f.zip']]);
  assert.deepEqual(items[1].headers, { referer: 'https://a.example/', 'x-token': 't' }, 'no cookies through items');
  assert.equal(cleanItems(new Array(500).fill({ url: 'https://a.example/x' })).length, 200);
});

test('install asks first; fetch only reaches the extension\u2019s own sites; results per page', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-se-ud-'));
  const store = {};
  let answer = false;
  const fetched = [];
  const se = new SiteExtensions({
    settings: { get: (k) => store[k], set: (p) => Object.assign(store, p) }, userDataDir: userData,
    confirm: async () => answer,
    fetchText: async (url) => { fetched.push(url); return { status: 200, url, text: '{}' }; },
    // A stand-in sandbox: answers with fixed items (the real one is tested in the app).
    createSandbox: () => {
      const box = { webContents: { id: 77 }, onResult: null, destroy() {} };
      box.run = async (job) => {
        if (job.page.url.includes('fail')) return box.onResult({ error: 'boom' });
        const r = await se.fetchFor(77, 'https://a.example/api').catch((e) => ({ error: e.message }));
        const blocked = await se.fetchFor(77, 'https://evil.example/x').catch((e) => e.message);
        box.onResult({ items: [{ url: 'https://a.example/file.zip', name: blocked }, r] });
      };
      return box;
    },
  });
  const src = extFolder({ name: 'Example A', version: '2', matches: ['https://a.example/*'] });
  assert.deepEqual(await se.installFromFolder(src), { ok: false, cancelled: true });
  assert.deepEqual(se.list(), []);
  answer = true;
  const inst = await se.installFromFolder(src);
  assert.equal(inst.ok, true);
  assert.deepEqual(se.list().map((e) => [e.name, e.enabled]), [['Example A', true]]);

  const res = await se.resolvePage({ url: 'https://a.example/page' });
  assert.equal(res.length, 1);
  assert.equal(res[0].items[0].url, 'https://a.example/file.zip');
  assert.match(res[0].items[0].name, /may not read evil\.example/);
  assert.deepEqual(fetched, ['https://a.example/api'], 'only its own site was fetched');
  assert.deepEqual(await se.resolvePage({ url: 'https://other.example/' }), [], 'not run on other sites');
  assert.equal((await se.resolvePage({ url: 'https://a.example/fail' }))[0].error, 'boom');
  await assert.rejects(se.fetchFor(12345, 'https://a.example/'), /Not allowed/, 'no fetch outside a run');

  se.setEnabled(inst.id, false);
  assert.deepEqual(await se.resolvePage({ url: 'https://a.example/page' }), []);
  se.remove(inst.id);
  assert.deepEqual(se.list(), []);
});
