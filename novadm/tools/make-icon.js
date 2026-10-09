'use strict';
// Draws the NovaDM icon (download arrow over a blue-violet rounded square) and writes
// assets/icon.png (512 px) and assets/icon.ico (16-256 px, PNG-compressed entries).
const fs = require('fs');
const path = require('path');
const { encode } = require('./png');

const SS = 4; // supersampling per axis for anti-aliasing

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundRectInside(x, y, inset, r) {
  const lo = inset + r, hi = 1 - inset - r;
  const cx = Math.max(lo, Math.min(hi, x)), cy = Math.max(lo, Math.min(hi, y));
  return Math.hypot(x - cx, y - cy) <= r && x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset;
}

// Glyph: a download arrow (stem + chevron) above a curved "novadm" baseline.
const STROKE = 0.105;
const SEGMENTS = [
  [0.5, 0.2, 0.5, 0.58],
  [0.3, 0.42, 0.5, 0.62],
  [0.7, 0.42, 0.5, 0.62],
];
function onGlyph(x, y) {
  for (const [ax, ay, bx, by] of SEGMENTS) if (segDist(x, y, ax, ay, bx, by) <= STROKE / 2) return true;
  // NovaDM: a shallow arc under the arrow, with round caps like the arrow strokes.
  const cx = 0.5, cy = 0.28, r = 0.52, half = 0.045, x0 = 0.27, x1 = 0.73;
  const d = Math.hypot(x - cx, y - cy);
  if (Math.abs(d - r) <= half && y > 0.5 && x >= x0 && x <= x1) return true;
  const ey = cy + Math.sqrt(r * r - (cx - x0) ** 2);
  if (Math.hypot(x - x0, y - ey) <= half || Math.hypot(x - x1, y - ey) <= half) return true;
  return false;
}

function pixelAt(size) {
  return (px, py) => {
    let bgCov = 0, glyphCov = 0, rr = 0, gg = 0, bb = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size;
        const y = (py + (sy + 0.5) / SS) / size;
        if (!roundRectInside(x, y, 0.03, 0.22)) continue;
        bgCov++;
        // Diagonal gradient #4f7dfb -> #7a4dfa
        const t = (x + y) / 2;
        rr += 79 + (122 - 79) * t; gg += 125 + (77 - 125) * t; bb += 251 + (250 - 251) * t;
        if (onGlyph(x, y)) glyphCov++;
      }
    }
    const n = SS * SS;
    if (!bgCov) return [0, 0, 0, 0];
    const bgA = bgCov / n;
    const gFrac = glyphCov / bgCov;
    const r = (rr / bgCov) * (1 - gFrac) + 255 * gFrac;
    const g = (gg / bgCov) * (1 - gFrac) + 255 * gFrac;
    const b = (bb / bgCov) * (1 - gFrac) + 255 * gFrac;
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(bgA * 255)];
  };
}

function render(size) { return encode(size, size, pixelAt(size)); }

function ico(pngs) {
  // ICONDIR + ICONDIRENTRY[n] + PNG payloads.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
const sizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(sizes.map((s) => ({ size: s, data: render(s) }))));
console.log('wrote assets/icon.png and assets/icon.ico');
