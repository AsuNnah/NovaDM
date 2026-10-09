'use strict';
// After a download finishes:
//  - Mark of the Web: the file gets a Zone.Identifier stream (ZoneId=3, "from the internet"), like
//    browsers write, so Windows SmartScreen and Office Protected View check it before it runs.
//  - Virus scan with Microsoft Defender's command-line scanner (MpCmdRun.exe), when installed.
// Only Windows and NTFS support these; elsewhere they are skipped quietly.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function markOfTheWeb(file, { url = '', referrer = '', incognito = false } = {}) {
  if (process.platform !== 'win32') return false;
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  // Private tabs: say "from the internet" without recording where (as Chromium does).
  if (incognito) lines.push('HostUrl=about:internet');
  else {
    if (/^https?:/i.test(referrer)) lines.push('ReferrerUrl=' + referrer);
    if (/^https?:/i.test(url)) lines.push('HostUrl=' + url);
  }
  try {
    fs.writeFileSync(file + ':Zone.Identifier', lines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false; // FAT/exFAT drives have no alternate data streams
  }
}

function readMarkOfTheWeb(file) {
  try { return fs.readFileSync(file + ':Zone.Identifier', 'utf8'); } catch { return ''; }
}

const versionKey = (name) => name.split(/[.-]/).map((x) => String(Number(x) || 0).padStart(8, '0')).join('.');

/** Path of Defender's MpCmdRun.exe (newest platform version first), or ''. */
function findDefender() {
  if (process.platform !== 'win32') return '';
  const cands = [];
  try {
    const plat = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
    const dirs = fs.readdirSync(plat).sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    for (const d of dirs) cands.push(path.join(plat, d, 'MpCmdRun.exe'));
  } catch {}
  cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'));
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

/**
 * Read MpCmdRun's output. Its exit code is 2 both for "threat found" and for "scan failed", so the
 * text decides. Returns { result: 'clean' | 'threat' | 'error', detail }.
 */
function parseScanOutput(out) {
  const text = String(out || '');
  if (/found no threats/i.test(text)) return { result: 'clean', detail: '' };
  const m = /found\s+(\d+)\s+threats?/i.exec(text);
  if (m && Number(m[1]) > 0) {
    const name = /Threat\s*:\s*(.+)/i.exec(text);
    return { result: 'threat', detail: name ? name[1].trim() : `${m[1]} threat(s)` };
  }
  const fail = /\[Failed\][^\r\n]*|Failed with hr\s*=\s*\S+/i.exec(text);
  return { result: 'error', detail: fail ? fail[0].trim() : 'The scan did not finish' };
}

let defenderPath = null;
/** Scan one file. Resolves { result: 'clean'|'threat'|'error'|'unavailable', detail }. */
function scanFile(file, { timeoutMs = 5 * 60 * 1000 } = {}) {
  if (defenderPath === null) defenderPath = findDefender();
  if (!defenderPath) return Promise.resolve({ result: 'unavailable', detail: 'Microsoft Defender is not available' });
  return new Promise((resolve) => {
    execFile(defenderPath, ['-Scan', '-ScanType', '3', '-File', file], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const parsed = parseScanOutput(`${stdout || ''}\n${stderr || ''}`);
      if (parsed.result === 'error' && err && err.killed) parsed.detail = 'The scan took too long';
      resolve(parsed);
    });
  });
}

/** Should this download be scanned? setting: 'programs' (programs + archives) | 'all' | 'off'. */
function wantsScan(setting, category) {
  if (setting === 'all') return true;
  if (setting === 'off') return false;
  return category === 'programs' || category === 'archives';
}

module.exports = { markOfTheWeb, readMarkOfTheWeb, findDefender, parseScanOutput, scanFile, wantsScan };
