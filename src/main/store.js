'use strict';
// Small JSON file store: atomic writes (temp file + rename) and debounced saving.
// On Windows the rename can be refused for a moment (EPERM / EBUSY / EACCES) while an antivirus or the
// search indexer still has one of the files open. A refused rename is retried, then the data is written
// in place; and a newer, complete temp file left by an earlier refusal is read back at start-up,
// so nothing that was saved gets lost.
const fs = require('fs');
const path = require('path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_MS = [10, 30, 60, 120, 250]; // at most about half a second in all

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function readJson(file) {
  try { return { data: JSON.parse(fs.readFileSync(file, 'utf8')), mtime: fs.statSync(file).mtimeMs }; } catch (e) { return { error: e }; }
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = defaults;
    this.timer = null;
    const main = readJson(file);
    const tmp = readJson(file + '.tmp');
    if (main.error && main.error.code !== 'ENOENT') {
      // Corrupt file: keep a copy for inspection.
      try { fs.copyFileSync(file, file + '.corrupt'); } catch {}
    }
    if (!tmp.error && (main.error || tmp.mtime > main.mtime)) {
      // The last save couldn't replace the file: its temp file holds the newest data.
      this.data = tmp.data;
      this.flush();
    } else {
      if (!main.error) this.data = main.data;
      try { fs.unlinkSync(file + '.tmp'); } catch {} // an older or broken leftover, not needed
    }
  }

  save(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    const text = JSON.stringify(this.data);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, text);
    } catch (e) {
      console.error('store write failed', this.file, e);
      return;
    }
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, this.file); return; } catch (e) {
        if (!RETRY_CODES.has(e.code)) { console.error('store write failed', this.file, e); return; }
        if (i < RETRY_MS.length) { pause(RETRY_MS[i]); continue; }
        // Still refused: write the file in place (not atomic, but the temp file stays as a complete copy).
        try {
          fs.writeFileSync(this.file, text);
          try { fs.unlinkSync(tmp); } catch {}
        } catch (e2) {
          console.error('store write failed', this.file, e2);
        }
        return;
      }
    }
  }
}

module.exports = { JsonStore };
