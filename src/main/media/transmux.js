'use strict';
// Convert an MPEG-TS stream to fragmented MP4 using mux.js, one HLS segment at a time.
// Usage:
//   const tx = new TsToMp4((buf) => writeChunk(buf));
//   for each segment: tx.push(tsBytes); tx.flushSegment();   // output is written per segment
//   tx.end();
// Resuming a download part-way: pass { initWritten: true, startSeconds } so the init segment isn't
// written twice and the timeline continues where the earlier output stopped.
let muxjs = null;
const CLOCK = 90000; // MPEG-TS timestamps tick at 90 kHz
const JUMP = 2 * CLOCK; // a segment starting more than 2 s away from where the last one ended is a restart

/** The first PTS (90 kHz) in an MPEG-TS buffer, video preferred; null when none is found. */
function firstPts(buf) {
  let audio = null;
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47 || !(buf[i + 1] & 0x40)) continue; // a packet that starts a PES
    let p = i + 4;
    if (buf[i + 3] & 0x20) p += 1 + buf[i + 4]; // adaptation field
    if (p + 14 > i + 188 || buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1 || !(buf[p + 7] & 0x80)) continue;
    const pts = ((buf[p + 9] >> 1) & 7) * 2 ** 30 + buf[p + 10] * 2 ** 22 + (buf[p + 11] >> 1) * 2 ** 15 + buf[p + 12] * 2 ** 7 + (buf[p + 13] >> 1);
    const id = buf[p + 3];
    if (id >= 0xe0 && id <= 0xef) return pts;
    if (audio === null && id >= 0xc0 && id <= 0xdf) audio = pts;
  }
  return audio;
}
function getMux() {
  if (!muxjs) muxjs = require('mux.js');
  return muxjs;
}

class TsToMp4 {
  constructor(onData, { initWritten = false, startSeconds = 0 } = {}) {
    this.onData = onData;
    this.initWritten = initWritten;
    this.bytes = 0;
    this.at = startSeconds; // where the next segment starts on the output timeline (s)
    this.prev = null; // { pts, duration } of the last segment pushed
    this.open(startSeconds);
  }

  // A fresh mux.js transmuxer whose output starts at `seconds`. (Its setBaseMediaDecodeTime only
  // resets the clock origin, it never moves the tracks, so a restart needs a new one.)
  open(seconds) {
    this.transmuxer = new (getMux().mp4.Transmuxer)({
      remux: true,
      keepOriginalTimestamps: false, // timeline starts at 0 (best player compatibility)
      baseMediaDecodeTime: Math.round(seconds * CLOCK),
    });
    this.transmuxer.on('data', (segment) => {
      if (!this.initWritten) {
        this.emit(Buffer.from(segment.initSegment.buffer, segment.initSegment.byteOffset, segment.initSegment.byteLength));
        this.initWritten = true;
      }
      this.emit(Buffer.from(segment.data.buffer, segment.data.byteOffset, segment.data.byteLength));
    });
  }

  emit(buf) {
    this.bytes += buf.length;
    this.onData(buf);
  }

  /**
   * duration: the segment's length from the playlist (s). Some streams restart their clock in every
   * segment (or jump): mux.js would then place each segment at time 0, and a slightly negative start
   * wraps to 2^32 ticks (a 2 h video shows 13:15:21). Such a segment is rebased to start where the
   * previous one ended; continuous streams are left alone.
   */
  push(buf, duration = 0) {
    const pts = duration > 0 ? firstPts(buf) : null;
    if (pts !== null && this.prev && this.prev.pts !== null) {
      const expected = this.prev.pts + this.prev.duration * CLOCK;
      if (Math.abs(pts - expected) > JUMP) {
        this.transmuxer.flush();
        this.open(this.at); // the init segment is already written, so only fragments follow
      }
    }
    this.prev = { pts, duration };
    this.at += duration;
    this.transmuxer.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  }

  // Emit everything pushed so far as one MP4 fragment. Call once per HLS segment so memory stays
  // bounded to a single segment.
  flushSegment() {
    this.transmuxer.flush();
  }

  end() {
    this.transmuxer.flush();
    return this.bytes;
  }
}

module.exports = { TsToMp4, firstPts };
