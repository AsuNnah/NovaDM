'use strict';
// Fragmented MP4 (ISO-BMFF / CMAF) tools: read boxes, and merge separate tracks (for example the
// video and the audio of a DASH stream, or an HLS stream whose audio is a separate rendition) into
// one MP4 without re-encoding.
//
// Output layout: ftyp + moov (every input track, renumbered 1..n, with an mvex/trex each), then the
// inputs' moof+mdat pairs, renumbered (mfhd sequence, tfhd track ID) and written in time order.
// Boxes that would point to the wrong place in the new file (sidx, styp, emsg, prft) are dropped.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

/** Top-level boxes in buf[start, end): [{ type, start, end, header }]. Stops at a truncated box. */
function readBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, end: p + size, header });
    p += size;
  }
  return out;
}

const children = (buf, box) => readBoxes(buf, box.start + box.header, box.end);
const child = (buf, box, type) => children(buf, box).find((b) => b.type === type);
const path = (buf, box, ...types) => types.reduce((b, t) => (b ? child(buf, b, t) : null), box);

function makeBox(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

// tkhd / mdhd: version 1 has 64-bit times, so later fields move by 8 (two times) bytes.
function tkhdTrackIdPos(buf, box) { return box.start + box.header + (buf[box.start + box.header] === 1 ? 20 : 12); }
function mdhdTimescale(buf, box) { return buf.readUInt32BE(box.start + box.header + (buf[box.start + box.header] === 1 ? 20 : 12)); }

/** Read an init segment (ftyp + moov). */
function parseInit(buf) {
  const top = readBoxes(buf);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('The stream has no MP4 header (moov)');
  const kids = children(buf, moov);
  const mvhd = kids.find((b) => b.type === 'mvhd');
  const mvex = kids.find((b) => b.type === 'mvex');
  const trexes = mvex ? children(buf, mvex).filter((b) => b.type === 'trex').map((b) => ({ id: buf.readUInt32BE(b.start + 12), buf: buf.subarray(b.start, b.end) })) : [];
  const tracks = kids.filter((b) => b.type === 'trak').map((t) => {
    const tkhd = child(buf, t, 'tkhd');
    const mdhd = path(buf, t, 'mdia', 'mdhd');
    const hdlr = path(buf, t, 'mdia', 'hdlr');
    const stsd = path(buf, t, 'mdia', 'minf', 'stbl', 'stsd');
    const sampleType = stsd && stsd.end >= stsd.start + 24 ? buf.toString('latin1', stsd.start + 20, stsd.start + 24) : '';
    return {
      id: buf.readUInt32BE(tkhdTrackIdPos(buf, tkhd)),
      timescale: mdhd ? mdhdTimescale(buf, mdhd) : 90000,
      handler: hdlr ? buf.toString('latin1', hdlr.start + 16, hdlr.start + 20) : '',
      sampleType,
      box: t,
    };
  });
  const encrypted = kids.some((b) => b.type === 'pssh') || tracks.some((t) => ['encv', 'enca', 'enct'].includes(t.sampleType));
  return { buf, ftyp, mvhd, tracks, trexes, encrypted };
}

class Mp4Merger {
  /** inits: one init segment (Buffer) per input stream. */
  constructor(inits) {
    this.inputs = inits.map((b) => parseInit(b));
    if (this.inputs.some((i) => i.encrypted)) {
      const e = new Error('This stream is DRM-protected and cannot be downloaded');
      e.code = 'DRM';
      throw e;
    }
    // New track IDs 1..n in input order; map per input from old to new.
    let next = 1;
    this.maps = this.inputs.map((inp) => {
      const m = new Map();
      for (const t of inp.tracks) m.set(t.id, next++);
      return m;
    });
    this.tracks = [];
    this.inputs.forEach((inp, i) => inp.tracks.forEach((t) => this.tracks.push({ input: i, id: this.maps[i].get(t.id), timescale: t.timescale, handler: t.handler })));
    this.seq = 1;
    this.outPos = 0;
    this.timeShift = this.inputs.map(() => 0); // added to tfdt, per input (in that track's timescale)
    this.lastEnd = this.inputs.map(() => 0); // where each input's timeline got to (same units)
    this.init = this.buildInit();
  }

  buildInit() {
    const first = this.inputs[0];
    const ftyp = first.ftyp ? first.buf.subarray(first.ftyp.start, first.ftyp.end)
      : makeBox('ftyp', Buffer.from('iso6'), Buffer.from([0, 0, 0, 0]), Buffer.from('iso6mp41dash'));
    const mvhd = Buffer.from(first.buf.subarray(first.mvhd.start, first.mvhd.end));
    mvhd.writeUInt32BE(this.tracks.length + 1, mvhd.length - 4); // next_track_ID is the last field
    const traks = [];
    const trexes = [];
    this.inputs.forEach((inp, i) => {
      for (const t of inp.tracks) {
        const newId = this.maps[i].get(t.id);
        const trak = Buffer.from(inp.buf.subarray(t.box.start, t.box.end));
        const tkhd = child(trak, readBoxes(trak)[0], 'tkhd');
        trak.writeUInt32BE(newId, tkhdTrackIdPos(trak, tkhd));
        traks.push(trak);
        const old = inp.trexes.find((x) => x.id === t.id);
        let trex;
        if (old) { trex = Buffer.from(old.buf); trex.writeUInt32BE(newId, 12); }
        else {
          trex = Buffer.alloc(32);
          trex.writeUInt32BE(32, 0); trex.write('trex', 4, 'latin1');
          trex.writeUInt32BE(newId, 12); trex.writeUInt32BE(1, 16); // sample description index
        }
        trexes.push(trex);
      }
    });
    const moov = makeBox('moov', mvhd, ...traks, makeBox('mvex', ...trexes));
    this.outPos = ftyp.length + moov.length;
    return Buffer.concat([ftyp, moov]);
  }

  /**
   * Rewrite one media segment (any number of moof+mdat pairs) of input `i`.
   * absOffset: where `buf` starts in its original file (for streams that use absolute offsets).
   * durationHint: the segment's length in seconds; when a stream's clock starts again (a new DASH
   *   period, an HLS discontinuity) the input is shifted so its timeline keeps going forward.
   * Returns { data, startTime } with startTime in seconds (for interleaving), or null if empty.
   */
  fragment(i, buf, { absOffset = 0, durationHint = 0 } = {}) {
    const boxes = readBoxes(buf);
    const scale = (this.tracks.find((x) => x.input === i) || {}).timescale || 90000;
    const first = firstTfdt(buf, boxes);
    if (first != null && this.lastEnd[i] && first + this.timeShift[i] < this.lastEnd[i] - scale / 2) {
      this.timeShift[i] += this.lastEnd[i] - (first + this.timeShift[i]);
    }
    const pieces = [];
    let startTime = Infinity;
    let pos = this.outPos;
    for (const b of boxes) {
      if (b.type === 'moof') {
        const moof = Buffer.from(buf.subarray(b.start, b.end));
        const top = readBoxes(moof)[0];
        for (const c of children(moof, top)) {
          if (c.type === 'mfhd') moof.writeUInt32BE(this.seq++, c.start + 12);
          if (c.type !== 'traf') continue;
          const tfhd = child(moof, c, 'tfhd');
          if (!tfhd) continue;
          const oldId = moof.readUInt32BE(tfhd.start + 12);
          const newId = this.maps[i].get(oldId) || this.maps[i].values().next().value;
          moof.writeUInt32BE(newId, tfhd.start + 12);
          const flags = moof.readUInt32BE(tfhd.start + 8) & 0xffffff;
          if (flags & 0x1) {
            // Absolute base offset into the original file: move it to the same place in ours.
            const base = Number(moof.readBigUInt64BE(tfhd.start + 16));
            moof.writeBigUInt64BE(BigInt(pos + (base - absOffset - b.start)), tfhd.start + 16);
          }
          const tfdt = child(moof, c, 'tfdt');
          if (tfdt) {
            const v1 = moof[tfdt.start + 8] === 1;
            let t = v1 ? Number(moof.readBigUInt64BE(tfdt.start + 12)) : moof.readUInt32BE(tfdt.start + 12);
            if (this.timeShift[i]) {
              t = Math.max(0, t + this.timeShift[i]);
              if (v1) moof.writeBigUInt64BE(BigInt(t), tfdt.start + 12);
              else moof.writeUInt32BE(Math.min(t, 0xffffffff), tfdt.start + 12);
            }
            const track = this.tracks.find((x) => x.id === newId);
            startTime = Math.min(startTime, t / ((track && track.timescale) || 90000));
          }
        }
        pieces.push(moof);
        pos += moof.length;
      } else if (b.type === 'mdat') {
        pieces.push(buf.subarray(b.start, b.end));
        pos += b.end - b.start;
      }
      // styp, sidx, emsg, prft, free, skip: dropped.
    }
    if (!pieces.length) return null;
    const data = Buffer.concat(pieces);
    this.outPos += data.length;
    if (first != null) this.lastEnd[i] = Math.max(this.lastEnd[i], first + this.timeShift[i] + Math.round(durationHint * scale));
    return { data, startTime: startTime === Infinity ? 0 : startTime };
  }

  /** Continue a merge after a restart: the next sequence number and where the file ends. */
  restore({ seq, outPos }) { this.seq = seq; this.outPos = outPos; }

  state() { return { seq: this.seq, outPos: this.outPos }; }
}

function firstTfdt(buf, boxes) {
  for (const b of boxes) {
    if (b.type !== 'moof') continue;
    for (const c of children(buf, b)) {
      if (c.type !== 'traf') continue;
      const tfdt = child(buf, c, 'tfdt');
      if (tfdt) return buf[tfdt.start + 8] === 1 ? Number(buf.readBigUInt64BE(tfdt.start + 12)) : buf.readUInt32BE(tfdt.start + 12);
    }
  }
  return null;
}

/** Is this buffer a fragmented MP4 (has moof) or a plain one (moov + mdat)? */
function isFragmented(buf) {
  return readBoxes(buf).some((b) => b.type === 'moof' || b.type === 'mvex');
}

/** Parse a sidx box: segment byte ranges (relative to the end of the sidx + first_offset) and durations. */
function parseSidx(buf, box) {
  const p0 = box.start + box.header;
  const v = buf[p0];
  let p = p0 + 4 + 4; // version/flags, reference_ID
  const timescale = buf.readUInt32BE(p); p += 4;
  let earliest; let firstOffset;
  if (v === 0) { earliest = buf.readUInt32BE(p); firstOffset = buf.readUInt32BE(p + 4); p += 8; }
  else { earliest = Number(buf.readBigUInt64BE(p)); firstOffset = Number(buf.readBigUInt64BE(p + 8)); p += 16; }
  p += 2; // reserved
  const count = buf.readUInt16BE(p); p += 2;
  const refs = [];
  let offset = box.end + firstOffset;
  let time = earliest;
  for (let k = 0; k < count; k++) {
    const a = buf.readUInt32BE(p);
    const duration = buf.readUInt32BE(p + 4);
    p += 12;
    const size = a & 0x7fffffff;
    refs.push({ offset, size, time, duration, timescale, isSidx: !!(a >>> 31) });
    offset += size;
    time += duration;
  }
  return { timescale, refs };
}

module.exports = { readBoxes, children, child, makeBox, parseInit, Mp4Merger, isFragmented, parseSidx };
