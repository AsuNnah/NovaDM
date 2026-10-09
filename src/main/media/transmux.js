'use strict';
// Convert an MPEG-TS stream to fragmented MP4 using mux.js, one HLS segment at a time.
// Usage:
//   const tx = new TsToMp4((buf) => writeChunk(buf));
//   for each segment: tx.push(tsBytes); tx.flushSegment();   // output is written per segment
//   tx.end();
// Resuming a download part-way: pass { initWritten: true, startSeconds } so the init segment isn't
// written twice and the timeline continues where the earlier output stopped.
let muxjs = null;
function getMux() {
  if (!muxjs) muxjs = require('mux.js');
  return muxjs;
}

class TsToMp4 {
  constructor(onData, { initWritten = false, startSeconds = 0 } = {}) {
    this.onData = onData;
    this.initWritten = initWritten;
    this.bytes = 0;
    const mux = getMux();
    this.transmuxer = new mux.mp4.Transmuxer({
      remux: true,
      keepOriginalTimestamps: false, // timeline starts at 0 (best player compatibility)
      baseMediaDecodeTime: Math.round(startSeconds * 90000), // 90 kHz clock
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

  push(buf) {
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

module.exports = { TsToMp4 };
