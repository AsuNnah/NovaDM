'use strict';
// 1.8.0 (SEC-107): hosts that sent Strict-Transport-Security over a valid HTTPS connection. A certificate error on
// one of them gets no "Proceed (unsafe)", as in Chrome. Normal windows keep them in hsts.json; private windows in
// memory only (no file). Cleared with the browsing history.
const { JsonStore } = require('./store');

const MAX = 5000;

class Hsts {
  constructor(file) {
    this.store = file ? new JsonStore(file, { hosts: {} }) : { data: { hosts: {} }, save() {} };
    if (!this.store.data || typeof this.store.data.hosts !== 'object' || !this.store.data.hosts) this.store.data = { hosts: {} };
  }
  get hosts() { return this.store.data.hosts; }

  /** A response header from `host`; max-age=0 forgets it. */
  note(host, header, now = Date.now()) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
    const m = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?\s*(?:;|$)/i.exec(String(header || ''));
    if (!h || !m) return;
    const age = Math.min(Number(m[1]), 2 * 365 * 86400);
    const old = this.hosts[h];
    delete this.hosts[h]; // re-added last, so the oldest is dropped first
    if (age > 0) {
      this.hosts[h] = [now + age * 1000, /(?:^|;)\s*includesubdomains\s*(?:;|$)/i.test(header) ? 1 : 0];
      const keys = Object.keys(this.hosts);
      for (let i = 0; i < keys.length - MAX; i++) delete this.hosts[keys[i]];
    } else if (!old) return;
    this.store.save();
  }

  /** True when `host`, or a parent that covers its sub-domains, is a remembered HSTS host. */
  has(host, now = Date.now()) {
    const parts = String(host || '').toLowerCase().replace(/:\d+$/, '').split('.');
    for (let i = 0; i < parts.length; i++) {
      const e = this.hosts[parts.slice(i).join('.')];
      if (e && e[0] > now && (i === 0 || e[1])) return true;
    }
    return false;
  }

  clear() { this.store.data = { hosts: {} }; this.store.save(); }
}

module.exports = { Hsts, MAX };
