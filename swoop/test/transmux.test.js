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
