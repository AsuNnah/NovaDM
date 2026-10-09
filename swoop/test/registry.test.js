'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MediaRegistry } = require('../src/main/media/registry');

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1855000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8
`;
function media(n, dur = 5) {
  let s = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n';
  for (let i = 0; i < n; i++) s += `#EXTINF:${dur},\nseg_${String(i).padStart(5, '0')}.mp4\n`;
  return s + '#EXT-X-ENDLIST\n';
}

function makeRegistry(files) {
  const fetched = [];
  const reg = new MediaRegistry({
    fetchText: async (url) => {
      fetched.push(url);
      const p = new URL(url).pathname;
      if (!(p in files)) throw new Error('404 ' + p);
      return { text: files[p], finalUrl: url };
    },
    getSetting: (k) => ({ minMediaKB: 300, pageTitleNames: true, convertTsToMp4: true }[k]),
  });
  return { reg, fetched };
}
const resp = (id, url, ct, extra = {}) => ({ id, url, method: 'GET', statusCode: 200, resourceType: 'xhr', headers: { 'content-type': ct }, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 25));

test('HLS master becomes one item with variants, duration, parts and size estimate', async () => {
  const { reg } = makeRegistry({ '/v/master.m3u8': MASTER, '/v/720/index.m3u8': media(1620), '/v/360/index.m3u8': media(1620) });
  const tab = 1;
  reg.setPageInfo(tab, { url: 'https://host.example/watch', title: 'My clip' });
  reg.onResponse(tab, resp(1, 'https://host.example/v/master.m3u8', 'application/vnd.apple.mpegurl'));
  await tick();
  const { items } = reg.list(tab);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.kind, 'hls');
  assert.equal(it.variants.length, 2);
  assert.equal(it.variants[0].label, '720p');
  assert.equal(it.parts, 1620);
  assert.equal(it.duration, 8100);
  assert.ok(it.sizeEstimate > 0);
  assert.equal(it.name, 'My clip [720p].mp4');
});

test('segment requests do not create items and mark the stream as playing', async () => {
  const { reg } = makeRegistry({ '/v/master.m3u8': MASTER, '/v/720/index.m3u8': media(10), '/v/360/index.m3u8': media(10) });
  const tab = 2;
  reg.onResponse(tab, resp(1, 'https://host.example/v/master.m3u8', 'application/vnd.apple.mpegurl'));
  await tick();
  reg.onResponse(tab, resp(2, 'https://host.example/v/720/seg_00000.mp4', 'video/mp4', { resourceType: 'media', headers: { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 * 1024) } }));
  const { items } = reg.list(tab);
  assert.equal(items.length, 1);
  assert.equal(items[0].playing, true);
});

test('the same playlist on two CDN hosts is merged with a mirror', async () => {
  const { reg } = makeRegistry({
    '/u/x/master.m3u8': MASTER, '/u/x/720/index.m3u8': media(5), '/u/x/360/index.m3u8': media(5),
  });
  const tab = 3;
  reg.onResponse(tab, resp(1, 'https://cdn1.host.example/u/x/master.m3u8', 'application/vnd.apple.mpegurl'));
  await tick();
  reg.onResponse(tab, resp(2, 'https://cdn2.host.example/u/x/master.m3u8', 'application/vnd.apple.mpegurl'));
  const { items } = reg.list(tab);
  assert.equal(items.length, 1);
  assert.equal(items[0].mirrors.length, 1);
  assert.match(items[0].mirrors[0], /cdn2/);
});

test('direct MP4 and a subtitle are separate items, sorted media-first', async () => {
  const { reg } = makeRegistry({});
  const tab = 4;
  reg.setPageInfo(tab, { url: 'https://host.example/watch', title: 'Clip' });
  reg.onResponse(tab, resp(1, 'https://host.example/movie.mp4', 'video/mp4', { resourceType: 'media', headers: { 'content-type': 'video/mp4', 'content-length': String(80 * 1024 * 1024) } }));
  reg.onResponse(tab, resp(2, 'https://host.example/subs/en.vtt', 'text/vtt'));
  const { items } = reg.list(tab);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'video');
  assert.equal(items[1].kind, 'subtitle');
  assert.equal(reg.count(tab), 1);
});

test('standalone media playlist gets duration and parts', async () => {
  const { reg } = makeRegistry({ '/s/720p.m3u8': media(100, 6) });
  const tab = 5;
  reg.onResponse(tab, resp(1, 'https://host.example/s/720p.m3u8', 'application/x-mpegurl'));
  await tick();
  const { items } = reg.list(tab);
  assert.equal(items.length, 1);
  assert.equal(items[0].parts, 100);
  assert.equal(items[0].duration, 600);
  assert.equal(items[0].variants[0].label, '720p');
});

test('DRM session key marks the item protected', async () => {
  const drmMaster = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
720/index.m3u8
`;
  const { reg } = makeRegistry({ '/d/master.m3u8': drmMaster, '/d/720/index.m3u8': media(5) });
  const tab = 6;
  reg.onResponse(tab, resp(1, 'https://host.example/d/master.m3u8', 'application/vnd.apple.mpegurl'));
  await tick();
  assert.equal(reg.list(tab).items[0].encryption, 'drm');
});
