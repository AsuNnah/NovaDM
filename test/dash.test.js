'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dash = require('../src/main/media/dash');
const { makeBox } = require('../src/main/media/mp4');

const MPD_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>https://cdn.example.com/v/</BaseURL>
  <Period id="p0">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s" startNumber="1" timescale="1000" duration="4000"/>
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
      <Representation id="720p" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="360p" bandwidth="700000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="de" mimeType="audio/mp4">
      <SegmentTemplate initialization="a/$Bandwidth$/init.mp4" media="a/$Bandwidth$/$Number$.m4s" timescale="48000" duration="192000"/>
      <Representation id="de" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="en" mimeType="audio/mp4">
      <SegmentTemplate initialization="a/$Bandwidth$/init.mp4" media="a/$Bandwidth$/$Number$.m4s" timescale="48000" duration="192000"/>
      <Representation id="en-lo" bandwidth="64000" codecs="mp4a.40.2"/>
      <Representation id="en-hi" bandwidth="96000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('durations and templates', () => {
  assert.equal(dash.parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(dash.parseDuration('P1DT1S'), 86401);
  assert.equal(dash.fillTemplate('$RepresentationID$/$Number%04d$-$Time$.m4s$$', { RepresentationID: 'v1', Number: 7, Time: 120 }), 'v1/0007-120.m4s$');
});

test('SegmentTemplate with $Number$: segments, URLs and choice of tracks', () => {
  const mpd = dash.parse(MPD_TEMPLATE, 'https://cdn.example.com/watch/manifest.mpd');
  assert.equal(mpd.live, false);
  assert.equal(mpd.duration, 10);
  const p = mpd.periods[0];
  const { video, audio, drm } = dash.pick(p, { height: 720, lang: 'en' });
  assert.equal(video.id, '720p');
  assert.equal(audio.id, 'en-hi');
  assert.equal(drm, false);
  const v = dash.segmentsFor(video);
  assert.equal(v.init.url, 'https://cdn.example.com/v/video/720p/init.mp4');
  assert.deepEqual(v.segments.map((s) => s.url.split('/').pop()), ['seg-00001.m4s', 'seg-00002.m4s', 'seg-00003.m4s']);
  assert.deepEqual(v.segments.map((s) => s.time), [0, 4, 8]);
  const a = dash.segmentsFor(audio);
  assert.equal(a.init.url, 'https://cdn.example.com/v/a/96000/init.mp4');
  assert.equal(a.segments.length, 3);
  assert.equal(dash.pick(p).video.id, '1080p', 'best video when no height is given');
});

test('SegmentTimeline with repeats and $Time$', () => {
  const mpd = dash.parse(`<MPD type="static" mediaPresentationDuration="PT20S"><Period>
    <AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="90000" initialization="init-$RepresentationID$.mp4" media="chunk-$RepresentationID$-$Time$.m4s">
      <SegmentTimeline><S t="0" d="360000" r="2"/><S d="180000"/><S d="360000" r="-1"/></SegmentTimeline>
    </SegmentTemplate><Representation id="v" bandwidth="1" height="480"/></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
  const s = dash.segmentsFor(mpd.periods[0].sets[0].representations[0]).segments;
  // 3 x 4 s, then 2 s, then 4 s repeated to the end of the 20 s period: 0,4,8,12,14,18
  assert.deepEqual(s.map((x) => x.time), [0, 4, 8, 12, 14, 18]);
  assert.equal(s[4].url, 'https://h.example/chunk-v-1260000.m4s');
});

test('SegmentList with byte ranges, ContentProtection marks DRM', () => {
  const mpd = dash.parse(`<MPD type="static" mediaPresentationDuration="PT6S"><Period>
    <AdaptationSet mimeType="audio/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="a" bandwidth="1"><BaseURL>audio.mp4</BaseURL>
        <SegmentList timescale="1" duration="3"><Initialization sourceURL="audio.mp4" range="0-799"/>
          <SegmentURL media="audio.mp4" mediaRange="800-1999"/><SegmentURL media="audio.mp4" mediaRange="2000-2999"/></SegmentList>
      </Representation></AdaptationSet></Period></MPD>`, 'https://h.example/dir/m.mpd');
  const rep = mpd.periods[0].sets[0].representations[0];
  assert.equal(rep.drm, true);
  assert.equal(dash.pick(mpd.periods[0]).drm, true);
  const s = dash.segmentsFor(rep);
  assert.deepEqual(s.init, { url: 'https://h.example/dir/audio.mp4', range: { offset: 0, length: 800 } });
  assert.deepEqual(s.segments.map((x) => x.range), [{ offset: 800, length: 1200 }, { offset: 2000, length: 1000 }]);
});

test('SegmentBase: the index (sidx) gives the segment ranges', () => {
  const mpd = dash.parse(`<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4">
    <Representation id="v" bandwidth="1" height="720"><BaseURL>https://media.example/v.mp4</BaseURL>
      <SegmentBase indexRange="700-799"><Initialization range="0-699"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
  const s = dash.segmentsFor(mpd.periods[0].sets[0].representations[0]);
  assert.deepEqual(s.init.range, { offset: 0, length: 700 });
  assert.deepEqual(s.index.range, { offset: 700, length: 100 });
  // A sidx (v0) with two references of 1000 and 1500 bytes, 4 s each at timescale 1000.
  const body = Buffer.alloc(4 + 4 + 4 + 8 + 2 + 2 + 24);
  let p = 4; body.writeUInt32BE(1, p); p += 4; body.writeUInt32BE(1000, p); p += 4;
  body.writeUInt32BE(0, p); body.writeUInt32BE(0, p + 4); p += 8; p += 2; body.writeUInt16BE(2, p); p += 2;
  for (const size of [1000, 1500]) { body.writeUInt32BE(size, p); body.writeUInt32BE(4000, p + 4); body.writeUInt32BE(0x90000000, p + 8); p += 12; }
  const sidx = makeBox('sidx', body);
  const segs = dash.segmentsFromSidx(sidx, 'https://media.example/v.mp4', 700);
  assert.deepEqual(segs.map((x) => [x.range.offset, x.range.length, x.time]), [[700 + sidx.length, 1000, 0], [700 + sidx.length + 1000, 1500, 4]]);
});

test('periods follow each other and live manifests are recognised', () => {
  const mpd = dash.parse(`<MPD type="static" mediaPresentationDuration="PT30S">
    <Period id="ad" duration="PT10S"><AdaptationSet mimeType="video/mp4"><Representation id="x" bandwidth="1"/></AdaptationSet></Period>
    <Period id="main"><AdaptationSet mimeType="video/mp4"><Representation id="y" bandwidth="1"/></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
  assert.deepEqual(mpd.periods.map((p) => [p.id, p.start, p.duration]), [['ad', 0, 10], ['main', 10, 20]]);
  assert.equal(dash.parse('<MPD type="dynamic" minimumUpdatePeriod="PT2S"><Period/></MPD>', 'https://h/m.mpd').live, true);
  assert.throws(() => dash.parse('<html></html>', 'https://h/x'));
});
