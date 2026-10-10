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

// Passwords a page sends: main.js checks them against known data breaches (breach.js) and warns about
// plain http://. Every frame, so sign-in boxes embedded from another site count too.
const checkedPasswords = new Set();
function passwordsSent(root) {
  for (const f of (root && root.querySelectorAll ? root.querySelectorAll('input[type=password]') : [])) {
    const v = f.value;
    if (v && v.length >= 4 && !checkedPasswords.has(v)) {
      checkedPasswords.add(v);
      try { ipcRenderer.send('novadm:password-sent', { password: v, secure: location.protocol === 'https:' }); } catch {}
    }
  }
}
if (/^https?:$/.test(location.protocol)) {
  window.addEventListener('submit', (e) => { if (e.isTrusted) passwordsSent(e.target); }, true);
  window.addEventListener('click', (e) => {
    const b = e.isTrusted && e.target && e.target.closest ? e.target.closest('button, input[type=submit], [role=button]') : null;
    if (b) passwordsSent(b.form || b.closest('form') || document);
  }, true);
  window.addEventListener('keydown', (e) => { if (e.isTrusted && e.key === 'Enter' && e.target && e.target.type === 'password') passwordsSent(e.target.form || document); }, true);
}

// The Chrome Web Store asks browsers that aren't Chrome to "Switch to Chrome", although "Add to
// NovaDM" works (electron-chrome-web-store): its popup and banner are hidden.
if (location.hostname === 'chromewebstore.google.com') {
  try { contextBridge.executeInMainWorld({ func: hideSwitchToChrome }); } catch {}
}
function hideSwitchToChrome() {
  let queued = false;
  const sweep = () => {
    queued = false;
    if (!document.body) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!/Switch to Chrome/.test(n.nodeValue) || !n.parentElement) continue;
      // The popup is a dialog; the banner is the smallest box around the sentence.
      let e = n.parentElement.closest('[role=dialog]');
      if (!e) { e = n.parentElement; while (e.parentElement && e.parentElement !== document.body && (e.parentElement.innerText || '').length <= 100) e = e.parentElement; }
      e.style.setProperty('display', 'none', 'important');
    }
  };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(sweep); } }).observe(document, { childList: true, subtree: true, characterData: true });
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
