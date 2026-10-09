'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hls = require('../src/main/media/hls');

const MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8?token=a,b
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
https://cdn2.example.com/1080p/index.m3u8
`;

test('master playlist: variants sorted best-first, URLs resolved, separate audio flagged', () => {
  const p = hls.parse(MASTER, 'https://cdn.example.com/video/master.m3u8');
  assert.equal(p.type, 'master');
  assert.equal(p.variants.length, 3);
  assert.deepEqual(p.variants.map((v) => v.resolution.height), [1080, 720, 360]);
  assert.equal(p.variants[1].url, 'https://cdn.example.com/video/720p/index.m3u8?token=a,b');
  assert.equal(p.variants[1].avgBandwidth, 2000000);
  assert.equal(p.variants[0].audioSeparate, true);
  assert.equal(p.variants[1].audioSeparate, false);
  assert.equal(hls.variantLabel(p.variants[0]), '1080p');
  assert.equal(p.renditions[0].url, 'https://cdn.example.com/video/audio/en.m3u8');
  assert.equal(p.drm, false);
});

const MEDIA_AES = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:9.5,
seg_00000.ts
#EXTINF:10.0,
seg_00001.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x0000000000000000000000000000ABCD
#EXTINF:4.25,title here
seg_00002.ts
#EXT-X-ENDLIST
`;

test('media playlist: duration, sequence numbers, keys, IVs', () => {
  const p = hls.parse(MEDIA_AES, 'https://cdn.example.com/v/720p/index.m3u8');
  assert.equal(p.type, 'media');
  assert.equal(p.segments.length, 3);
  assert.equal(p.duration, 23.75);
  assert.equal(p.live, false);
  assert.equal(p.encryption, 'aes128');
  assert.equal(p.segments[0].seq, 5);
  assert.equal(p.segments[0].url, 'https://cdn.example.com/v/720p/seg_00000.ts');
  assert.equal(p.segments[0].key.url, 'https://cdn.example.com/v/720p/key.bin');
  assert.equal(hls.ivFor(p.segments[1]).toString('hex'), '00000000000000000000000000000006');
  assert.equal(hls.ivFor(p.segments[2]).toString('hex'), '0000000000000000000000000000abcd');
  assert.equal(p.segments[2].title, 'title here');
});

test('media playlist: fMP4 map, byte ranges, live', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
#EXT-X-BYTERANGE:1000@0
video.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:1500
video.mp4
`;
  const p = hls.parse(text, 'https://a.b/x/play.m3u8');
  assert.equal(p.live, true);
  assert.equal(p.hasMap, true);
  assert.equal(p.segments[0].map.url, 'https://a.b/x/init.mp4');
  assert.deepEqual(p.segments[0].range, { length: 1000, offset: 0 });
  assert.deepEqual(p.segments[1].range, { length: 1500, offset: 1000 });
});

test('DRM detection: SAMPLE-AES / Widevine keys and session keys', () => {
  const media = hls.parse(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6,
a.ts
#EXT-X-ENDLIST`, 'https://x.y/z.m3u8');
  assert.equal(media.encryption, 'drm');
  const master = hls.parse(`#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
#EXT-X-STREAM-INF:BANDWIDTH=1
a.m3u8`, 'https://x.y/z.m3u8');
  assert.equal(master.drm, true);
});

test('container sniffing', () => {
  const ts = Buffer.alloc(376); ts[0] = 0x47; ts[188] = 0x47;
  assert.equal(hls.sniffContainer(ts), 'ts');
  const mp4 = Buffer.from('0000001866747970', 'hex');
  assert.equal(hls.sniffContainer(Buffer.concat([mp4, Buffer.alloc(16)])), 'fmp4');
  assert.equal(hls.sniffContainer(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0])), 'aac');
  assert.throws(() => hls.parse('<html></html>', 'https://x'));
});
