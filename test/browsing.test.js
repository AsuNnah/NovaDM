'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History, Bookmarks, TabSession } = require('../src/main/library');
const { Shields, debounce, stripTrackingParams, deAmpUrl, isLocalHost } = require('../src/main/shields');

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

test('bookmarks: star toggle, edit, import and export (Chrome / Firefox HTML)', () => {
  const b = new Bookmarks(tmp());
  assert.strictEqual(b.toggle('https://a.example/', 'A'), true);
  assert.strictEqual(b.has('https://a.example/'), true);
  assert.strictEqual(b.toggle('https://a.example/', 'A'), false);
  assert.strictEqual(b.add({ url: 'javascript:alert(1)' }), null);
  const x = b.add({ url: 'https://x.example/', title: 'X' });
  b.add({ url: 'https://y.example/', title: 'Y' });
  assert.deepStrictEqual(b.list().map((i) => i.title), ['X', 'Y']);
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

test('shields: tracking redirects skipped', () => {
  assert.strictEqual(debounce('https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fpage&sa=D&usg=x'), 'https://example.org/page');
  assert.strictEqual(debounce('https://www.google.co.uk/url?url=https://example.org/'), 'https://example.org/');
  assert.strictEqual(debounce('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2F%3Fa%3D1&h=AT0'), 'https://example.org/?a=1');
  assert.strictEqual(debounce('https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.org&v=1'), 'https://example.org/');
  assert.strictEqual(debounce('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx'), 'https://example.org/x');
  assert.strictEqual(debounce('https://href.li/?https://example.org/y'), 'https://example.org/y');
  const b64 = Buffer.from('https://example.org/bing').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.strictEqual(debounce(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`), 'https://example.org/bing');
  // Not a redirect, or a target that isn't a web page: left alone.
  assert.strictEqual(debounce('https://www.google.com/search?q=cats'), null);
  assert.strictEqual(debounce('https://www.google.com/url?q=javascript:alert(1)'), null);
  assert.strictEqual(debounce('https://example.org/url?q=https://other.example/'), null);
});

test('shields: click identifiers removed, everything else kept', () => {
  assert.strictEqual(stripTrackingParams('https://shop.example/item?id=5&fbclid=AbC&utm_source=news'), 'https://shop.example/item?id=5&utm_source=news');
  assert.strictEqual(stripTrackingParams('https://shop.example/item?gclid=1&msclkid=2'), 'https://shop.example/item');
  assert.strictEqual(stripTrackingParams('https://shop.example/item?gclid=1#reviews'), 'https://shop.example/item#reviews');
  assert.strictEqual(stripTrackingParams('https://shop.example/item?id=5'), null);
  assert.strictEqual(stripTrackingParams('https://shop.example/'), null);
});

test('shields: AMP addresses to the publisher', () => {
  assert.strictEqual(deAmpUrl('https://www.google.com/amp/s/www.example.com/news/story.amp.html'), 'https://www.example.com/news/story.amp.html');
  assert.strictEqual(deAmpUrl('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/news/story?amp=1'), 'https://www.example.com/news/story?amp=1');
  assert.strictEqual(deAmpUrl('https://www-example-com.cdn.ampproject.org/v/s/www.example.com/a'), 'https://www.example.com/a');
  assert.strictEqual(deAmpUrl('https://www.google.com/search?q=amp'), null);
});

test('shields: HTTPS upgrade, local addresses, fallback and redirect loops', () => {
  const settings = { v: {}, get(k) { return this.v[k]; } };
  const s = new Shields(settings);
  assert.strictEqual(s.rewrite('http://example.org/page?x=1'), 'https://example.org/page?x=1');
  for (const local of ['http://localhost:8080/', 'http://192.168.1.1/', 'http://router/', 'http://nas.local/', 'http://app.test/', 'http://[::1]/']) {
    assert.strictEqual(s.rewrite(local), null, local);
  }
  assert.strictEqual(s.rewrite('http://example.org:8080/'), null); // a port: likely not HTTPS
  assert.strictEqual(s.rewrite('http://example.org/frame', { isMain: false }), null); // frames aren't upgraded
  // The HTTPS page failed: back to http, and the site stays on http.
  assert.strictEqual(s.fallback('https://example.org/page?x=1'), 'http://example.org/page?x=1');
  assert.strictEqual(s.rewrite('http://example.org/other'), null);
  // A site that sends HTTPS visitors back to http.
  assert.strictEqual(s.rewrite('http://loop.example/'), 'https://loop.example/');
  assert.strictEqual(s.rewrite('http://loop.example/'), null);
  // Rules combine; each can be turned off.
  assert.strictEqual(s.rewrite('http://www.google.com/url?q=http%3A%2F%2Fnews.example%2F%3Ffbclid%3D1'), 'https://news.example/');
  settings.v.httpsUpgrade = false;
  settings.v.debounceLinks = false;
  assert.strictEqual(s.rewrite('http://www.google.com/url?q=http%3A%2F%2Fnews.example%2F'), null);
  assert.ok(isLocalHost('10.0.0.5') && !isLocalHost('example.org'));
});

test('live DASH: segments available now, from the clock and from a timeline', () => {
  const dash = require('../src/main/media/dash');
  const ast = Date.UTC(2026, 9, 9, 10, 0, 0);
  const numbered = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-10-09T10:00:00Z" timeShiftBufferDepth="PT10S" minimumUpdatePeriod="PT2S"><Period id="p0" start="PT0S">
    <AdaptationSet contentType="video"><SegmentTemplate media="v/$Number$.m4s" initialization="v/init.mp4" timescale="1000" duration="2000" startNumber="5"/>
    <Representation id="v" bandwidth="1" height="720"/></AdaptationSet></Period></MPD>`;
  const m = dash.parse(numbered, 'https://live.example/s.mpd');
  assert.strictEqual(m.live, true);
  assert.strictEqual(m.availabilityStart, ast);
  assert.strictEqual(m.minimumUpdatePeriod, 2);
  const rep = m.periods[0].sets[0].representations[0];
  // 61 s after the start: segments 0..29 are complete (the 31st ends at 62 s); the last 10 s are kept.
  const s = dash.segmentsFor(rep, { now: ast + 61000 }).segments;
  assert.deepStrictEqual(s.map((x) => x.url.split('/').pop()), ['30.m4s', '31.m4s', '32.m4s', '33.m4s', '34.m4s']);
  assert.strictEqual(s[s.length - 1].time, 58);
  assert.strictEqual(dash.segmentsFor(rep, { now: ast + 63000 }).segments.pop().url.split('/').pop(), '35.m4s');

  // A timeline whose last entry repeats up to the live edge.
  const timeline = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="2026-10-09T10:00:00Z"><Period id="p0" start="PT0S">
    <AdaptationSet contentType="audio"><SegmentTemplate media="a/$Time$.m4s" timescale="10"><SegmentTimeline><S t="100" d="20" r="-1"/></SegmentTimeline></SegmentTemplate>
    <Representation id="a" bandwidth="1"/></AdaptationSet></Period></MPD>`;
  const t = dash.parse(timeline, 'https://live.example/t.mpd');
  const ts = dash.segmentsFor(t.periods[0].sets[0].representations[0], { now: ast + 19000 }).segments;
  // From t=10 s to the edge at 19 s: 10-12, 12-14, 14-16, 16-18 are complete.
  assert.deepStrictEqual(ts.map((x) => x.url.split('/').pop()), ['100.m4s', '120.m4s', '140.m4s', '160.m4s']);
  // Static manifests keep the old rule (the period's end, last segment included).
  const st = dash.parse(timeline.replace('type="dynamic"', 'type="static" mediaPresentationDuration="PT21S"'), 'https://x/t.mpd');
  assert.strictEqual(dash.segmentsFor(st.periods[0].sets[0].representations[0]).segments.length, 6);
});
