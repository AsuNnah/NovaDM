'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const muxjs = require('mux.js');
const { Mp4Merger, readBoxes, makeBox, parseInit, isFragmented } = require('../src/main/media/mp4');

const SEG = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts'));

// The test clip as two separate fragmented MP4 streams (video only, audio only), like DASH serves them.
function separateTracks(ts = SEG) {
  const tx = new muxjs.mp4.Transmuxer({ remux: false });
  const out = {};
  tx.on('data', (s) => {
    out[s.type] = {
      init: Buffer.from(s.initSegment.buffer, s.initSegment.byteOffset, s.initSegment.byteLength),
      data: Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength),
    };
  });
  tx.push(new Uint8Array(ts));
  tx.flush();
  return out;
}

const types = (buf) => readBoxes(buf).map((b) => b.type);

test('video and audio from separate streams become one MP4 with two tracks', () => {
  const { video, audio } = separateTracks();
  assert.ok(video && audio, 'test clip has both tracks');
  const m = new Mp4Merger([video.init, audio.init]);
  const v = m.fragment(0, video.data);
  const a = m.fragment(1, audio.data);
  const file = Buffer.concat([m.init, v.data, a.data]);

  assert.deepEqual(types(file), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']);
  const tracks = muxjs.mp4.probe.tracks(m.init);
  assert.deepEqual(tracks.map((t) => [t.id, t.type]).sort(), [[1, 'video'], [2, 'audio']].sort());
  const info = parseInit(m.init);
  assert.equal(info.trexes.length, 2);
  assert.deepEqual(info.trexes.map((t) => t.id).sort(), [1, 2]);

  // Each moof: renumbered, and every trun's data offset lands inside the mdat right after it.
  const parsed = muxjs.mp4.tools.inspect(new Uint8Array(file));
  const moofs = parsed.filter((b) => b.type === 'moof');
  assert.deepEqual(moofs.map((b) => b.boxes.find((x) => x.type === 'mfhd').sequenceNumber), [1, 2]);
  assert.deepEqual(moofs.map((b) => b.boxes.find((x) => x.type === 'traf').boxes.find((x) => x.type === 'tfhd').trackId), [1, 2]);
  const top = readBoxes(file);
  for (let k = 0; k < top.length; k++) {
    if (top[k].type !== 'moof') continue;
    const trun = moofs.shift().boxes.find((x) => x.type === 'traf').boxes.find((x) => x.type === 'trun');
    const mdat = top[k + 1];
    const at = top[k].start + trun.dataOffset;
    assert.ok(at >= mdat.start + 8 && at < mdat.end, `data offset points into the mdat (${at} in ${mdat.start}-${mdat.end})`);
  }
  assert.ok(isFragmented(file));
  assert.ok(Math.abs(v.startTime - a.startTime) < 1, 'start times in seconds are comparable');
});

test('fragments that use absolute file offsets are moved to their new place', () => {
  const { video } = separateTracks();
  const m = new Mp4Merger([video.init]);
  // Build a moof whose tfhd carries base_data_offset (flag 0x1), as if the segment sat at byte 5000
  // of its original file, with the samples right after the moof's mdat header.
  const tfhdBody = Buffer.alloc(16); tfhdBody.writeUInt32BE(0x000001, 0); tfhdBody.writeUInt32BE(256, 4);
  const trunBody = Buffer.alloc(12); trunBody.writeUInt32BE(0x000001, 0); trunBody.writeUInt32BE(0, 4); trunBody.writeInt32BE(0, 8);
  const build = (base) => {
    tfhdBody.writeBigUInt64BE(BigInt(base), 8);
    return makeBox('moof', makeBox('mfhd', Buffer.alloc(8)), makeBox('traf', makeBox('tfhd', tfhdBody), makeBox('trun', trunBody)));
  };
  const moofSize = build(0).length;
  const seg = Buffer.concat([build(5000 + moofSize + 8), makeBox('mdat', Buffer.from('samples!'))]);
  const before = m.outPos;
  const out = m.fragment(0, seg, { absOffset: 5000 }).data;
  const tfhd = readBoxes(out, 8 + 16, out.length); // moof header, mfhd
  const traf = tfhd[0];
  const base = Number(out.readBigUInt64BE(traf.start + 8 + 8 + 8));
  assert.equal(base, before + moofSize + 8, 'base offset now points at the samples in the merged file');
});

test('DRM-protected tracks are refused', () => {
  const { video } = separateTracks();
  const enc = Buffer.from(video.init);
  const i = enc.indexOf(Buffer.from('avc1'), enc.indexOf(Buffer.from('stsd'))); // the sample entry, not the ftyp brand
  enc.write('encv', i, 'latin1');
  assert.equal(parseInit(enc).encrypted, true);
  assert.throws(() => new Mp4Merger([enc]), (e) => e.code === 'DRM');
});
