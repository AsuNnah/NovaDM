'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TsToMp4 } = require('../src/main/media/transmux');

const SEG = path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts');

function topBoxes(buf) {
  const found = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    found.push(buf.toString('latin1', i + 4, i + 8));
    if (size < 8) break;
    i += size;
  }
  return found;
}

// baseMediaDecodeTime of each track fragment (moof > traf > tfdt), in file order.
function tfdts(buf) {
  const out = [];
  const walk = (start, end) => {
    let i = start;
    while (i + 8 <= end) {
      const size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      if (size < 8) break;
      if (type === 'moof' || type === 'traf') walk(i + 8, i + size);
      if (type === 'tfdt') {
        const version = buf[i + 8];
        out.push(version === 1 ? Number(buf.readBigUInt64BE(i + 12)) : buf.readUInt32BE(i + 12));
      }
      i += size;
    }
  };
  walk(0, buf.length);
  return out;
}

test('TS segment transmuxes to a valid fragmented MP4', () => {
  const chunks = [];
  const tx = new TsToMp4((b) => chunks.push(b));
  tx.push(fs.readFileSync(SEG));
  tx.flushSegment();
  const total = tx.end();
  const out = Buffer.concat(chunks);
  assert.ok(out.length > 10000, 'output should be sizeable, got ' + out.length);
  assert.equal(total, out.length);
  const top = topBoxes(out);
  for (const b of ['ftyp', 'moov', 'moof', 'mdat']) assert.ok(top.includes(b), `has ${b}: ${top.join(',')}`);
  assert.equal(tfdts(out)[0], 0, 'timeline starts at 0');
});

test('output is written after each segment, not held until the end', () => {
  const chunks = [];
  const tx = new TsToMp4((b) => chunks.push(b));
  tx.push(fs.readFileSync(SEG));
  assert.equal(chunks.length, 0, 'nothing before the segment is flushed');
  tx.flushSegment();
  const afterFirst = Buffer.concat(chunks).length;
  assert.ok(afterFirst > 10000, 'first segment written on flush');
});

test('resumed conversion skips the init segment and continues the timeline', () => {
  const chunks = [];
  const tx = new TsToMp4((b) => chunks.push(b), { initWritten: true, startSeconds: 10 });
  tx.push(fs.readFileSync(SEG));
  tx.flushSegment();
  const out = Buffer.concat(chunks);
  const top = topBoxes(out);
  assert.ok(!top.includes('ftyp') && !top.includes('moov'), 'no second init segment: ' + top.join(','));
  assert.ok(top.includes('moof') && top.includes('mdat'));
  const times = tfdts(out);
  // Video uses a 90 kHz timescale: 10 s -> 900000. Audio uses its sample rate.
  assert.ok(times.includes(900000), 'video continues at 10 s: ' + times.join(','));
});

module.exports = { tfdts };

// ---- timeline across segments (1.4.3: a 2 h video showed 13:15:21) ----
const { firstPts } = require('../src/main/media/transmux');
const { readBoxes, children, child } = require('../src/main/media/mp4');

// Start time (tfdt) of every fragment of the video track, in its own timescale.
function videoStarts(buf) {
  const starts = {};
  for (const moof of readBoxes(buf).filter((b) => b.type === 'moof')) {
    for (const traf of children(buf, moof).filter((b) => b.type === 'traf')) {
      const tfhd = child(buf, traf, 'tfhd');
      const tfdt = child(buf, traf, 'tfdt');
      const id = buf.readUInt32BE(tfhd.start + tfhd.header + 4);
      const v1 = buf[tfdt.start + tfdt.header] === 1;
      (starts[id] = starts[id] || []).push(v1 ? Number(buf.readBigUInt64BE(tfdt.start + tfdt.header + 4)) : buf.readUInt32BE(tfdt.start + tfdt.header + 4));
    }
  }
  return starts;
}

// A copy of a TS segment with every PTS / DTS moved by `add` ticks (a later piece of one stream).
function shiftTimestamps(seg, add) {
  const b = Buffer.from(seg);
  const write = (p, v) => {
    const prefix = b[p] & 0xf0;
    b[p] = prefix | ((Math.floor(v / 2 ** 30) & 7) << 1) | 1;
    b[p + 1] = Math.floor(v / 2 ** 22) & 0xff;
    b[p + 2] = ((Math.floor(v / 2 ** 15) & 0x7f) << 1) | 1;
    b[p + 3] = Math.floor(v / 2 ** 7) & 0xff;
    b[p + 4] = ((v & 0x7f) << 1) | 1;
  };
  const read = (p) => ((b[p] >> 1) & 7) * 2 ** 30 + b[p + 1] * 2 ** 22 + (b[p + 2] >> 1) * 2 ** 15 + b[p + 3] * 2 ** 7 + (b[p + 4] >> 1);
  for (let i = 0; i + 188 <= b.length; i += 188) {
    if (b[i] !== 0x47 || !(b[i + 1] & 0x40)) continue;
    let p = i + 4;
    if (b[i + 3] & 0x20) p += 1 + b[i + 4];
    if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
    const flags = b[p + 7] >> 6;
    if (flags & 2) write(p + 9, read(p + 9) + add);
    if (flags === 3) write(p + 14, read(p + 14) + add);
  }
  return b;
}

function convert(segments, duration) {
  const out = [];
  const tx = new TsToMp4((b) => out.push(Buffer.from(b)));
  for (const s of segments) { tx.push(s, duration); tx.flushSegment(); }
  tx.end();
  return Buffer.concat(out);
}

test('timeline: segments that restart their clock are placed one after another', () => {
  const seg = fs.readFileSync(SEG);
  assert.strictEqual(firstPts(seg), 126000); // 1.4 s
  const starts = videoStarts(convert(Array(6).fill(seg), 10));
  for (const [id, s] of Object.entries(starts)) {
    for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], `track ${id} goes forward: ${s.join(',')}`);
    assert.ok(s[s.length - 1] < 2 ** 31, `track ${id} never wraps: ${s.join(',')}`);
  }
  const video = Object.values(starts).find((s) => s[1] - s[0] === 900000); // 90 kHz track: 10 s apart
  assert.ok(video, 'video fragments 10 s apart: ' + JSON.stringify(starts));
});

test('timeline: a continuous stream is converted as before', () => {
  const seg = fs.readFileSync(SEG);
  const pieces = Array.from({ length: 6 }, (_, i) => shiftTimestamps(seg, i * 900000));
  const continuous = videoStarts(convert(pieces, 10));
  const plain = videoStarts((() => { const o = []; const tx = new TsToMp4((b) => o.push(Buffer.from(b))); for (const s of pieces) { tx.push(s); tx.flushSegment(); } tx.end(); return Buffer.concat(o); })());
  assert.deepStrictEqual(continuous, plain); // durations given or not: same timeline
});

test('length: the header of a finished MP4 says how long it is (mux.js leaves it unknown)', () => {
  const { readBoxes, child, children, writeDuration } = require('../src/main/media/mp4');
  const seg = fs.readFileSync(SEG);
  const chunks = [];
  const tx = new TsToMp4((b) => chunks.push(Buffer.from(b)));
  for (let i = 0; i < 3; i++) { tx.push(seg, 10); tx.flushSegment(); }
  tx.end();
  const file = path.join(require('os').tmpdir(), `novadm-length-${process.pid}.mp4`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  const lengths = () => {
    const buf = fs.readFileSync(file);
    const moov = readBoxes(buf).find((b) => b.type === 'moov');
    const at = (box, off) => buf.readUInt32BE(box.start + box.header + off); // version 0 boxes
    const mvhd = child(buf, moov, 'mvhd');
    const traks = children(buf, moov).filter((b) => b.type === 'trak');
    return {
      movie: at(mvhd, 16) / at(mvhd, 12),
      tkhd: traks.map((t) => at(child(buf, t, 'tkhd'), 20) / at(mvhd, 12)),
      mdhd: traks.map((t) => { const m = child(buf, child(buf, t, 'mdia'), 'mdhd'); return at(m, 16) / at(m, 12); }),
    };
  };
  try {
    assert.strictEqual(lengths().movie, 0xffffffff / 90000, 'mux.js writes "unknown" (shown as 13:15:21)');
    const fd = fs.openSync(file, 'r+');
    try { assert.ok(writeDuration(fd, tx.at)); } finally { fs.closeSync(fd); }
    const l = lengths();
    assert.strictEqual(tx.at, 30);
    assert.strictEqual(l.movie, 30);
    assert.deepStrictEqual(l.tkhd, [30, 30]);
    for (const s of l.mdhd) assert.ok(Math.abs(s - 30) < 0.001, `track length ${s}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
