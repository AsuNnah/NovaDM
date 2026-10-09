'use strict';
// Small JSON file store: atomic writes (temp file + rename) and debounced saving.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = defaults;
    this.timer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep a copy for inspection and start fresh.
        try { fs.copyFileSync(file, file + '.corrupt'); } catch {}
      }
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store write failed', this.file, e);
    }
  }
}

module.exports = { JsonStore };
