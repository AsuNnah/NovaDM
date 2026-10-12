'use strict';
// Housekeeping:
//  - Memory overload protection: when Windows runs low on memory, or NovaDM itself uses a large share
//    of it, background tabs are unloaded, least recently used first (like Chrome's Memory Saver).
//  - Leftovers from a crash: NovaDM's temp folders and Chromium's temp files older than a day.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOW_FREE = 0.10; // under 10 % of the PC's memory free
const APP_SHARE = 0.40; // or NovaDM using over 40 % of it
const DAY = 24 * 3600 * 1000;
const NOVADM_TMP = /^novadm-(ffmpeg|ytdlp|aria2|siteext)-/; // made by the add-on installers, yt-dlp and site extensions
const CHROMIUM_TMP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i; // Chromium's half-written files

/** Is memory short? freeBytes / totalBytes: the PC; appBytes: all of NovaDM's processes. */
function underPressure({ freeBytes, totalBytes, appBytes }) {
  if (!(totalBytes > 0)) return false;
  return freeBytes / totalBytes < LOW_FREE || appBytes / totalBytes > APP_SHARE;
}

/** NovaDM's processes together (Electron reports kilobytes). */
function appMemoryBytes(metrics) {
  return (metrics || []).reduce((s, p) => s + ((p.memory && p.memory.workingSetSize) || 0) * 1024, 0);
}

/** Remove leftovers older than a day; returns their names. Nothing in use is that old. */
function cleanLeftovers({ userDataDir, tmpDir = os.tmpdir(), now = Date.now() }) {
  const removed = [];
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const old = (p) => { try { return now - fs.statSync(p).mtimeMs > DAY; } catch { return false; } };
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.basename(p)); } catch {} };
  for (const n of list(tmpDir)) if (NOVADM_TMP.test(n) && old(path.join(tmpDir, n))) rm(path.join(tmpDir, n));
  if (userDataDir) for (const n of list(userDataDir)) if (CHROMIUM_TMP.test(n) && old(path.join(userDataDir, n))) rm(path.join(userDataDir, n));
  return removed;
}

/** Keep a session-long Map / Set from growing without end: forget the oldest entries past `max`. */
function capSize(collection, max = 1000) {
  for (const k of collection.keys()) { if (collection.size <= max) break; collection.delete(k); }
}

module.exports = { underPressure, appMemoryBytes, cleanLeftovers, capSize, LOW_FREE, APP_SHARE };
