'use strict';
// Shared token-bucket rate limiter for all active downloads. rateBytesPerSec = 0 means unlimited.
class RateLimiter {
  constructor(rateBytesPerSec = 0) {
    this.rate = rateBytesPerSec;
    this.tokens = rateBytesPerSec;
    this.last = Date.now();
    this.waiters = [];
    this.timer = null;
  }

  setRate(rateBytesPerSec) {
    this.rate = Math.max(0, rateBytesPerSec || 0);
    if (this.rate === 0) this.release();
  }

  refill() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.rate > 0) this.tokens = Math.min(this.rate, this.tokens + dt * this.rate);
  }

  // Resolve as many waiters as current tokens allow.
  pump() {
    this.refill();
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.rate === 0) { this.waiters.shift(); w.resolve(w.want); continue; }
      if (this.tokens >= 1) {
        const give = Math.min(w.want, Math.floor(this.tokens));
        this.tokens -= give;
        this.waiters.shift();
        w.resolve(give);
      } else break;
    }
    if (this.waiters.length && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 50);
    }
  }

  // Ask to transfer up to `want` bytes; resolves with how many are allowed now (>=1).
  take(want) {
    if (this.rate === 0) return Promise.resolve(want);
    return new Promise((resolve) => {
      this.waiters.push({ want: Math.max(1, want), resolve });
      this.pump();
    });
  }

  release() {
    for (const w of this.waiters.splice(0)) w.resolve(w.want);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

module.exports = { RateLimiter };
