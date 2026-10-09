'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History, Bookmarks, TabSession } = require('../src/main/library');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-lib-'));

test('history: visits, merging, search, suggestions, clearing by time', () => {
  let now = Date.UTC(2026, 9, 9, 12);
  const h = new History(tmp(), () => now);
  h.add('https://news.example/a', 'Alpha');
  now += 30 * 1000;
  h.add('https://news.example/a', 'Alpha (updated)'); // same page within a minute: one visit
  assert.strictEqual(h.visits.length, 1);
  assert.strictEqual(h.visits[0].title, 'Alpha (updated)');
  now += 5 * 60 * 1000;
  h.add('https://shop.example/b', '');
  h.setTitle('https://shop.example/b', 'Beta shop');
  h.add('file:///C:/x.html', 'local'); // not a web page
  h.add('novadm://settings', 'settings');
  assert.strictEqual(h.visits.length, 2);
  assert.deepStrictEqual(h.search({ q: '' }).map((v) => v.title), ['Beta shop', 'Alpha (updated)']);
  assert.deepStrictEqual(h.search({ q: 'shop beta' }).map((v) => v.title), ['Beta shop']);
  assert.deepStrictEqual(h.suggest('news').map((s) => s.url), ['https://news.example/a']);
  assert.deepStrictEqual(h.suggest('').length, 0);
  // Clearing the last hour keeps older visits.
  now += 2 * 3600 * 1000;
  h.add('https://late.example/', 'Late');
  h.clear(3600 * 1000);
  assert.deepStrictEqual(h.search({ q: '' }).map((v) => v.title), ['Beta shop', 'Alpha (updated)']);
  h.remove([h.visits[0].id]);
  assert.strictEqual(h.visits.length, 1);
  h.clear();
  assert.strictEqual(h.visits.length, 0);
});

test('history: kept 90 days, saved to disk', () => {
  const dir = tmp();
  let now = Date.UTC(2026, 0, 1);
  const h = new History(dir, () => now);
  h.add('https://old.example/', 'Old');
  now += 100 * 86400000;
  h.add('https://new.example/', 'New');
  h.flush();
  const again = new History(dir, () => now);
  assert.deepStrictEqual(again.visits.map((v) => v.title), ['New']);
});

test('bookmarks: star toggle, edit, move, import and export (Chrome / Firefox HTML)', () => {
  const b = new Bookmarks(tmp());
  assert.strictEqual(b.toggle('https://a.example/', 'A'), true);
  assert.strictEqual(b.has('https://a.example/'), true);
  assert.strictEqual(b.toggle('https://a.example/', 'A'), false);
  assert.strictEqual(b.add({ url: 'javascript:alert(1)' }), null);
  const x = b.add({ url: 'https://x.example/', title: 'X' });
  const y = b.add({ url: 'https://y.example/', title: 'Y' });
  b.move(y.id, 0);
  assert.deepStrictEqual(b.list().map((i) => i.title), ['Y', 'X']);
  b.update(x.id, { title: 'Ex', folder: 'Work', url: 'javascript:bad' });
  assert.strictEqual(b.find('https://x.example/').title, 'Ex');
  assert.strictEqual(b.find('https://x.example/').folder, 'Work');

  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://news.example/" ADD_DATE="1">News &amp; more</A>
    <DT><H3>Recipes</H3>
    <DL><p>
      <DT><A HREF="https://food.example/soup">Soup</A>
    </DL><p>
    <DT><A HREF="https://y.example/">Y again</A>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
  </DL><p>
</DL><p>`;
  const r = b.importHtml(html);
  assert.deepStrictEqual(r, { added: 2, skipped: 2 });
  assert.strictEqual(b.find('https://news.example/').title, 'News & more');
  assert.strictEqual(b.find('https://news.example/').folder, '');
  assert.strictEqual(b.find('https://food.example/soup').folder, 'Recipes');
  // Export and import into an empty list gives the same bookmarks back.
  const b2 = new Bookmarks(tmp());
  b2.importHtml(b.exportHtml());
  assert.deepStrictEqual(b2.list().map((i) => [i.url, i.title, i.folder]).sort(), b.list().map((i) => [i.url, i.title, i.folder]).sort());
});

test('tab session: web and NovaDM pages saved, others dropped', () => {
  const dir = tmp();
  const s = new TabSession(dir);
  s.save([{ url: 'https://a.example/', title: 'A' }, { url: 'novadm://downloads', title: 'Downloads' }, { url: 'file:///c:/x', title: 'x' }], 1);
  s.flush();
  const again = new TabSession(dir).load();
  assert.deepStrictEqual(again.tabs.map((t) => t.url), ['https://a.example/', 'novadm://downloads']);
  assert.strictEqual(again.active, 1);
});
