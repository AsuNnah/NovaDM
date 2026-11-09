'use strict';
// 1.7.14: one icon per site for the History panel: capped, size-limited, never from private tabs, cleared with history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SiteIcons, MAX_SITES, MAX_BYTES } = require('../src/main/site-icons');

const png = (n = 10) => ({ type: 'image/png', body: Buffer.alloc(n, 1) });

test('site icons: one per site, 500 at most, 64 KB each, never private, cleared with history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-icons-'));
  let t = 0;
  const icons = new SiteIcons(dir, () => ++t);
  let fetched = 0;
  const fetchIcon = async () => { fetched++; return png(); };

  assert.strictEqual(await icons.learn({ url: 'https://a.test/x', favicon: 'https://a.test/f.ico', incognito: true }, fetchIcon), false);
  assert.strictEqual(fetched, 0, 'a private tab never fetches or adds');
  assert.strictEqual(await icons.learn({ url: 'https://a.test/x', favicon: 'https://a.test/f.ico' }, fetchIcon), true);
  assert.match(icons.get('https://A.test/other/page'), /^data:image\/png;base64,/);
  assert.strictEqual(await icons.learn({ url: 'https://a.test/y', favicon: 'https://a.test/f.ico' }, fetchIcon), false);
  assert.strictEqual(fetched, 1, 'one per site: the same icon address is not fetched again');

  assert.strictEqual(await icons.learn({ url: 'https://big.test/', favicon: 'https://big.test/f.png' }, async () => png(MAX_BYTES + 1)), false);
  assert.strictEqual(await icons.learn({ url: 'https://html.test/', favicon: 'https://html.test/f' }, async () => ({ type: 'text/html', body: Buffer.from('x') })), false);
  assert.strictEqual(await icons.learn({ url: 'file:///C:/x.html', favicon: 'https://a.test/f.ico' }, fetchIcon), false);

  for (let i = 0; i < MAX_SITES + 5; i++) await icons.learn({ url: `https://s${i}.test/`, favicon: `https://s${i}.test/f.ico` }, fetchIcon);
  assert.strictEqual(Object.keys(icons.sites).length, MAX_SITES);
  assert.strictEqual(icons.get('https://a.test/'), '', 'the least recently seen site went first');
  assert.notStrictEqual(icons.get(`https://s${MAX_SITES + 4}.test/`), '');

  icons.keepOnly(['https://s504.test/page']);
  assert.deepStrictEqual(Object.keys(icons.sites), ['s504.test']);
  icons.flush();
  assert.deepStrictEqual(Object.keys(new SiteIcons(dir).sites), ['s504.test'], 'saved to site-icons.json');
  icons.keepOnly([]);
  assert.deepStrictEqual(icons.sites, {});
  // An icon still loading when history is cleared doesn't come back after the clear.
  let release;
  const pending = icons.learn({ url: 'https://late.test/', favicon: 'https://late.test/f.ico' }, () => new Promise((r) => { release = () => r(png()); }));
  icons.keepOnly([]);
  release();
  assert.strictEqual(await pending, false);
  assert.deepStrictEqual(icons.sites, {});
  fs.rmSync(dir, { recursive: true, force: true });
});
