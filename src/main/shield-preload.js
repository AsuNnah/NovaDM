'use strict';
// Runs in every frame before the page's scripts (registered on the browsing sessions). Applies the
// Tor-style protections that hardening.js chose for this page, inside the page's own JavaScript.
const { ipcRenderer, contextBridge } = require('electron');

let cfg = null;
try { cfg = ipcRenderer.sendSync('novadm:shield-config'); } catch {}
// Bot checks (Cloudflare, hCaptcha, reCAPTCHA) inspect the browser itself: altered values make them loop.
const CAPTCHA = /(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net)$|^www\.google\.com$/;
const captchaFrame = CAPTCHA.test(location.hostname) && (location.hostname !== 'www.google.com' || location.pathname.startsWith('/recaptcha/'));
if (cfg && !captchaFrame && (cfg.fingerprinting !== 'off' || cfg.clickToPlay)) {
  try { contextBridge.executeInMainWorld({ func: protect, args: [cfg] }); } catch {}
}

// Serialized into the page: no outside references.
function protect(cfg) {
  const def = (proto, key, value) => { try { Object.defineProperty(proto, key, { get() { return value; }, configurable: true }); } catch {} };
  if (cfg.fingerprinting === 'strict') {
    // Like Tor Browser, the same values for everyone: CPU count, memory, screen size; the device APIs
    // trackers read are gone. Scripts can tell (workers still see the real CPU and memory), so some
    // sites' bot checks refuse this: Strict only.
    def(Navigator.prototype, 'hardwareConcurrency', 4);
    def(Navigator.prototype, 'deviceMemory', 8);
    for (const [k, v] of [['width', 1920], ['height', 1080], ['availWidth', 1920], ['availHeight', 1040], ['colorDepth', 24], ['pixelDepth', 24]]) def(Screen.prototype, k, v);
    for (const k of ['getBattery', 'getGamepads']) { try { delete Navigator.prototype[k]; } catch {} }
    for (const k of ['usb', 'hid', 'serial', 'bluetooth', 'connection']) def(Navigator.prototype, k, undefined);
  }
  if (cfg.fingerprinting !== 'off') {

    const gid = CanvasRenderingContext2D.prototype.getImageData;
    const tdu = HTMLCanvasElement.prototype.toDataURL;
    const tbl = HTMLCanvasElement.prototype.toBlob;
    const gcd = AudioBuffer.prototype.getChannelData;
    if (cfg.fingerprinting === 'strict') {
      // Like Tor Browser: canvas read-outs are blank, WebGL is off, audio read-outs are silent.
      CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) { return new ImageData(Math.max(1, Math.abs(w)), Math.max(1, Math.abs(h))); };
      const blank = (c) => { const b = document.createElement('canvas'); b.width = c.width; b.height = c.height; return b; };
      HTMLCanvasElement.prototype.toDataURL = function (...a) { return tdu.apply(blank(this), a); };
      HTMLCanvasElement.prototype.toBlob = function (...a) { return tbl.apply(blank(this), a); };
      const gc = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/i.test(type) ? null : gc.call(this, type, ...a); };
      AudioBuffer.prototype.getChannelData = function (...a) { const d = gcd.apply(this, a); return new Float32Array(d.length); };
    } else {
      // Like Brave: tiny noise, different per site and per NovaDM start, so read-outs don't match
      // across sites but canvases still look the same to people.
      // XOR with 1 or 2, never 0: every chosen byte changes (a 0 left some sites without noise).
      const noise = (data) => { for (let i = (cfg.seed % 97); i < data.length; i += 97) data[i] ^= 1 + ((cfg.seed >> (i % 13)) & 1); };
      CanvasRenderingContext2D.prototype.getImageData = function (...a) { const r = gid.apply(this, a); noise(r.data); return r; };
      // Before an export the canvas itself gets 1–2 changed pixels. Canvas pixels are stored
      // premultiplied: colour written into a transparent pixel is lost, so those get alpha instead.
      const noisy = (c) => {
        try {
          const ctx = c.getContext('2d');
          if (ctx && c.width && c.height) {
            const row = gid.call(ctx, 0, 0, Math.min(c.width, 64), 1);
            const d = row.data;
            for (let p = (cfg.seed % 61) * 4; p < d.length; p += 61 * 4) {
              const a = d[p + 3];
              if (a === 255) d[p] ^= 1 + (cfg.seed & 1); else d[p + 3] = a === 0 ? 1 + (cfg.seed & 3) : a ^ 1;
            }
            ctx.putImageData(row, 0, 0);
          }
        } catch {}
        return c;
      };
      HTMLCanvasElement.prototype.toDataURL = function (...a) { return tdu.apply(noisy(this), a); };
      HTMLCanvasElement.prototype.toBlob = function (...a) { return tbl.apply(noisy(this), a); };
      AudioBuffer.prototype.getChannelData = function (...a) { const d = gcd.apply(this, a); for (let i = cfg.seed % 101; i < d.length; i += 101) d[i] += 1e-7; return d; };
    }
  }
  if (cfg.clickToPlay) {
    // Tor's Safer level: audio and video only start when clicked.
    const play = HTMLMediaElement.prototype.play;
    let clicked = false;
    addEventListener('pointerdown', (e) => { if (e.isTrusted) { clicked = true; setTimeout(() => { clicked = false; }, 1000); } }, true);
    HTMLMediaElement.prototype.play = function (...a) { return clicked ? play.apply(this, a) : Promise.reject(new DOMException('Click to play', 'NotAllowedError')); };
    const stop = (n) => { n.autoplay = false; n.preload = 'none'; };
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n instanceof HTMLMediaElement) stop(n);
        else if (n.querySelectorAll) n.querySelectorAll('video, audio').forEach(stop); // inserted as HTML
      }
    }).observe(document, { childList: true, subtree: true });
  }
}
