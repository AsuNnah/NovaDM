'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Bookmarks } = require('../src/main/bookmarks');
const { detectBrowsers, fromChromiumJson, fromFirefox, fromFileText } = require('../src/main/bookmarks-import');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-bm-'));
const kids = (b, p) => b.children(p).map((n) => n.title);

test('bookmarks: star toggle, edit, validation', () => {
  const b = new Bookmarks(tmp());
  assert.strictEqual(b.toggle('https://a.example/', 'A'), true);
  assert.strictEqual(b.has('https://a.example/'), true);
  assert.strictEqual(b.toggle('https://a.example/', 'A'), false);
  assert.strictEqual(b.add({ url: 'javascript:alert(1)' }), null);
  const x = b.add({ url: 'https://x.example/', title: 'X' });
  b.update(x.id, { title: 'Ex', url: 'javascript:bad' });
  assert.strictEqual(b.find('https://x.example/').title, 'Ex');
  assert.strictEqual(x.parent, 'bar');
});

test('bookmarks: folders, nesting, moving, order, removing', () => {
  const b = new Bookmarks(tmp());
  const f = b.addFolder('Work');
  const g = b.addFolder('Deep', f.id);
  const a = b.add({ url: 'https://a.example/', title: 'A' });
  const c = b.add({ url: 'https://c.example/', title: 'C', parent: f.id });
  const d = b.add({ url: 'https://d.example/', title: 'D', parent: 'nonsense' });
  assert.strictEqual(d.parent, 'bar'); // an unknown parent falls back to the bar
  assert.deepStrictEqual(kids(b, 'bar'), ['Work', 'A', 'D']);
  // Reorder on the bar: D to the front.
  assert.ok(b.move(d.id, 'bar', 0));
  assert.deepStrictEqual(kids(b, 'bar'), ['D', 'Work', 'A']);
  // Into a folder, at a place; and to "other".
  assert.ok(b.move(a.id, f.id, 0));
  assert.deepStrictEqual(kids(b, f.id), ['A', 'Deep', 'C']);
  assert.ok(b.move(c.id, 'other', 99));
  assert.deepStrictEqual(kids(b, 'other'), ['C']);
  // A folder can't go into itself or below itself.
  assert.strictEqual(b.move(f.id, f.id, 0), false);
  assert.strictEqual(b.move(f.id, g.id, 0), false);
  assert.strictEqual(b.move(999, 'bar', 0), false);
  assert.deepStrictEqual(b.urlsIn(f.id).map((n) => n.title), ['A']);
  // Deleting a folder deletes what is inside.
  b.remove(f.id);
  assert.strictEqual(b.has('https://a.example/'), false);
  assert.strictEqual(b.node(g.id), null);
  assert.deepStrictEqual(kids(b, 'bar'), ['D']);
  assert.strictEqual(b.has('https://c.example/'), true);
});

test('bookmarks: a 1.6 file is converted, backed up, and survives a reload', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), JSON.stringify({ seq: 3, items: [
    { id: 1, url: 'https://one.example/', title: 'One', folder: '', added: 5, icon: 'data:image/png;base64,AA==' },
    { id: 2, url: 'https://two.example/', title: 'Two', folder: 'Recipes', added: 6 },
    { id: 3, url: 'https://three.example/', title: 'Three', folder: 'Recipes', added: 7 },
  ] }));
  const b = new Bookmarks(dir);
  assert.deepStrictEqual(kids(b, 'bar'), ['One', 'Recipes']);
  const recipes = b.children('bar')[1];
  assert.deepStrictEqual(kids(b, recipes.id), ['Two', 'Three']);
  assert.strictEqual(b.find('https://one.example/').icon, 'data:image/png;base64,AA==');
  assert.strictEqual(b.add({ url: 'https://new.example/' }).id > 3, true); // new ids don't clash
  assert.ok(fs.existsSync(path.join(dir, 'bookmarks.v1.json')));
  b.flush();
  const again = new Bookmarks(dir);
  assert.deepStrictEqual(kids(again, 'bar'), ['One', 'Recipes', 'new.example']);
  assert.deepStrictEqual(kids(again, recipes.id), ['Two', 'Three']);
});

test('bookmarks: HTML import keeps the tree, bar and other; skips duplicates and bookmarklets', () => {
  const b = new Bookmarks(tmp());
  b.add({ url: 'https://y.example/', title: 'Y' });
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://news.example/" ADD_DATE="1">News &amp; more</A>
    <DT><H3>Recipes</H3>
    <DL><p>
      <DT><A HREF="https://food.example/soup">Soup</A>
      <DT><H3>Sweet</H3>
      <DL><p>
        <DT><A HREF="https://food.example/cake">Cake</A>
      </DL><p>
    </DL><p>
    <DT><A HREF="https://y.example/">Y again</A>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
  </DL><p>
  <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other bookmarks</H3>
  <DL><p>
    <DT><A HREF="https://later.example/">Later</A>
  </DL><p>
</DL><p>`;
  assert.deepStrictEqual(b.importHtml(html), { added: 4, skipped: 2 });
  assert.strictEqual(b.find('https://news.example/').title, 'News & more');
  assert.deepStrictEqual(kids(b, 'bar'), ['Y', 'News & more', 'Recipes']);
  const recipes = b.children('bar').find((n) => n.title === 'Recipes');
  assert.deepStrictEqual(kids(b, recipes.id), ['Soup', 'Sweet']);
  assert.strictEqual(b.node(b.find('https://food.example/cake').parent).title, 'Sweet');
  assert.deepStrictEqual(kids(b, 'other'), ['Later']);
  // Importing the same file again adds nothing, and doesn't duplicate folders.
  assert.deepStrictEqual(b.importHtml(html), { added: 0, skipped: 6 });
  assert.strictEqual(b.nodes.filter((n) => n.type === 'folder').length, 2);
  // Export and import into an empty list gives the same tree back (Chrome / Edge / Firefox read this format).
  const b2 = new Bookmarks(tmp());
  b2.importHtml(b.exportHtml());
  const shape = (x) => JSON.stringify(['bar', 'other'].map((r) => { const walk = (p) => x.children(p).map((n) => (n.type === 'url' ? [n.title, n.url] : [n.title, walk(n.id)])); return walk(r); }));
  assert.strictEqual(shape(b2), shape(b));
});

test('import: Chrome / Edge / Brave "Bookmarks" file', () => {
  const file = JSON.stringify({ roots: {
    bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
      { type: 'url', name: 'Docs', url: 'https://docs.example/' },
      { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'Spec', url: 'https://spec.example/' }] },
    ] },
    other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'Misc', url: 'https://misc.example/' }] },
    synced: { type: 'folder', name: 'Mobile bookmarks', children: [{ type: 'url', name: 'Phone', url: 'https://phone.example/' }] },
  } });
  const b = new Bookmarks(tmp());
  assert.deepStrictEqual(b.importTree(fromChromiumJson(file)), { added: 4, skipped: 0 });
  assert.deepStrictEqual(kids(b, 'bar'), ['Docs', 'Dev']);
  assert.deepStrictEqual(kids(b, 'other'), ['Misc', 'Mobile bookmarks']);
  // A picked file is told apart by its content.
  assert.deepStrictEqual(Object.keys(fromFileText(file)), ['bar', 'other']);
  assert.strictEqual(fromFileText('<DL><DT><A HREF="https://a.example/">A</A></DL>').other[0].url, 'https://a.example/');
});

test('import: Firefox places.sqlite (read from a copy)', (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('node:sqlite not available'); return; }
  const dir = tmp();
  const file = path.join(dir, 'places.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT);
    INSERT INTO moz_places VALUES (1, 'https://ff.example/'), (2, 'https://menu.example/'), (3, 'https://deep.example/');
    INSERT INTO moz_bookmarks VALUES
      (1, 2, NULL, 0, 0, '', 'root________'),
      (2, 2, NULL, 1, 0, 'menu', 'menu________'),
      (3, 2, NULL, 1, 1, 'toolbar', 'toolbar_____'),
      (4, 2, NULL, 1, 2, 'unfiled', 'unfiled_____'),
      (5, 1, 1, 3, 0, 'FF site', 'a'),
      (6, 2, NULL, 3, 1, 'Stuff', 'b'),
      (7, 1, 3, 6, 0, 'Deep', 'c'),
      (8, 1, 2, 2, 0, 'In menu', 'd'),
      (9, 3, NULL, 3, 2, NULL, 'sep');`);
  db.close();
  const tree = fromFirefox(file);
  assert.deepStrictEqual(tree.bar.map((n) => n.title), ['FF site', 'Stuff']);
  assert.strictEqual(tree.bar[1].children[0].url, 'https://deep.example/');
  assert.strictEqual(tree.other[0].title, 'Bookmarks menu');
  assert.strictEqual(fs.existsSync(file), true); // the original is only read
});

test('import: installed browsers are found by their usual folders', () => {
  const root = tmp();
  const put = (rel, text = '{}') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('Local/Google/Chrome/User Data/Local State', JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' } } } }));
  put('Local/Google/Chrome/User Data/Default/Bookmarks');
  put('Local/Google/Chrome/User Data/Profile 1/Bookmarks');
  put('Local/Google/Chrome/User Data/Profile 2/Cookies'); // no bookmarks: not listed
  put('Local/Microsoft/Edge/User Data/Default/Bookmarks');
  put('Roaming/Mozilla/Firefox/Profiles/abc123.default-release/places.sqlite', '');
  const found = detectBrowsers({ LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming') });
  assert.deepStrictEqual(found.map((f) => `${f.browser}/${f.profile}`), ['Chrome/Default', 'Chrome/Work', 'Edge/Default', 'Firefox/default-release']);
  assert.deepStrictEqual(detectBrowsers({}), []);
});

test('bookmarks: the folder used last is offered first, and new bookmarks go there', () => {
  const dir = tmp();
  const b = new Bookmarks(dir);
  const a = b.addFolder('A');
  const c = b.addFolder('C');
  assert.strictEqual(b.lastParent(), 'bar');
  assert.strictEqual(b.add({ url: 'https://one.example/' }).parent, 'bar');
  b.useFolder(a.id);
  b.useFolder(c.id);
  b.useFolder(a.id);
  assert.strictEqual(b.lastParent(), a.id);
  assert.deepStrictEqual(b.recentFolders().map((f) => f.title), ['A', 'C']); // newest first, no repeats
  assert.strictEqual(b.add({ url: 'https://two.example/' }).parent, a.id);
  b.useFolder('other'); // a root: remembered as the last place, not listed as a folder
  assert.strictEqual(b.add({ url: 'https://three.example/' }).parent, 'other');
  assert.deepStrictEqual(b.recentFolders().map((f) => f.title), ['A', 'C']);
  b.flush();
  assert.strictEqual(new Bookmarks(dir).lastParent(), 'other');
  // A folder that is gone is not offered, and the bar is used instead.
  b.useFolder(c.id);
  b.remove(c.id);
  assert.strictEqual(b.lastParent(), 'bar');
  assert.deepStrictEqual(b.recentFolders().map((f) => f.title), ['A']);
  b.useFolder(999); // not a folder: ignored
  assert.strictEqual(b.lastParent(), 'bar');
});

test('bookmarks: several at once (move, delete, open list)', () => {
  const b = new Bookmarks(tmp());
  const f = b.addFolder('F');
  const g = b.addFolder('G', f.id);
  const x = b.add({ url: 'https://x.example/', title: 'X', parent: f.id });
  const y = b.add({ url: 'https://y.example/', title: 'Y', parent: g.id });
  const z = b.add({ url: 'https://z.example/', title: 'Z' });
  const w = b.add({ url: 'https://w.example/', title: 'W' });
  // A folder and one of its own bookmarks both ticked: the bookmark moves with the folder, once.
  assert.strictEqual(b.moveMany([f.id, x.id, z.id], 'other'), 2);
  assert.deepStrictEqual(b.children('other').map((n) => n.title), ['F', 'Z']);
  assert.strictEqual(b.node(x.id).parent, f.id);
  // A folder can't go inside itself (or below itself); nothing moves.
  assert.strictEqual(b.moveMany([f.id], g.id), 0);
  // What "open" means for a folder: every bookmark inside, no repeats.
  assert.deepStrictEqual(b.urlsOf([f.id, y.id, w.id]).map((n) => n.title).sort(), ['W', 'X', 'Y']);
  b.removeMany([f.id, w.id]);
  assert.deepStrictEqual(b.list().map((n) => n.title), ['Z']);
  assert.strictEqual(b.node(g.id), null);
});
