'use strict';
// Clipboard watcher: when a download link is copied anywhere (another app, a chat, a forum), offer to
// download it. Only links whose file type is on the user's list count (or HLS playlists). Text that
// NovaDM copies itself ("Copy link address", Properties) is ignored. Nothing is stored or sent.
const { EventEmitter } = require('events');
const { clipboard } = require('electron');
const { extractLinks, extOf } = require('./util');

const POLL_MS = 1000;
const selfCopies = new Set();

/** Copy text from NovaDM itself (the watcher won't offer it as a download). */
function copyText(text) {
  const t = String(text || '');
  selfCopies.add(t);
  if (selfCopies.size > 20) selfCopies.delete(selfCopies.values().next().value);
  clipboard.writeText(t);
}

function extensionList(setting) {
  return new Set(String(setting || '').toLowerCase().split(/[\s,;]+/).map((x) => x.replace(/^\./, '')).filter(Boolean));
}

/** Download links in text, keeping those whose file extension is in exts (and .m3u8 streams). */
function downloadLinks(text, exts) {
  return extractLinks(text, 200).filter((u) => {
    if (/^magnet:\?/i.test(u)) return true;
    let p = '';
    try { p = decodeURIComponent(new URL(u).pathname); } catch { return false; }
    const ext = extOf(p);
    return ext === 'm3u8' || exts.has(ext);
  });
}

class ClipboardWatcher extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.timer = null;
    this.last = '';
    settings.on('change', (c) => { if ('clipboardWatch' in c) this.update(); });
    this.update();
  }

  update() {
    const on = !!this.settings.get('clipboardWatch');
    if (on && !this.timer) {
      this.primed = false;
      // What is already there when watching starts doesn't count.
      this.read().then((t) => { this.last = t; this.primed = true; });
      this.timer = setInterval(() => this.tick(), POLL_MS);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // clipboard.readText() is asynchronous in current Electron (older versions return the string).
  async read() {
    try { return String((await clipboard.readText()) || ''); } catch { return ''; }
  }

  async tick() {
    if (this._busy || !this.primed) return;
    this._busy = true;
    let text;
    try { text = await this.read(); } finally { this._busy = false; }
    if (!this.timer || text === this.last) return;
    this.last = text;
    if (!text || text.length > 200000) return;
    if (selfCopies.delete(text)) return;
    const links = downloadLinks(text, extensionList(this.settings.get('clipboardExtensions')));
    if (links.length) this.emit('links', links);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { ClipboardWatcher, copyText, downloadLinks, extensionList };
