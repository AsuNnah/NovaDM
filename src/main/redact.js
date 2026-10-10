'use strict';
// Removes personal data from text that may be shared (the "Report a problem" file):
// web addresses keep only the site, and user folders, user / PC names, e-mail addresses and long
// tokens are replaced.
const os = require('os');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "C:\Users\you\Downloads\bank\statement.pdf" -> "%USERPROFILE%\Downloads\…\[file].pdf"
function shortPath(p) {
  const parts = p.split(/[\\/]+/);
  const last = parts[parts.length - 1];
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(last);
  const dirs = parts.slice(1, ext ? -1 : undefined);
  return parts[0] + (dirs[0] ? '\\' + dirs[0] : '') + (dirs.length > 1 ? '\\…' : '') + (ext ? '\\[file]' + ext[0] : '');
}

function redact(text, { user = os.userInfo().username, pc = os.hostname(), home = os.homedir(), appPath = '' } = {}) {
  let s = String(text == null ? '' : text);
  // NovaDM's own files stay readable ([app]\src\main\…), so error traces still point at the code.
  if (appPath) s = s.replace(new RegExp(escapeRe(appPath), 'gi'), '[app]');
  if (home) s = s.replace(new RegExp(escapeRe(home), 'gi'), '%USERPROFILE%');
  s = s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/gi, '%USERPROFILE%');
  // Folders may have spaces ("Android to Windows"); the last part ends at a space.
  s = s.replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:|%USERPROFILE%)(?:[\\/]+[^\\/"'`<>:*?|\r\n]+(?=[\\/]))*[\\/]+[^\\/\s"'`<>:*?|]+/g, shortPath);
  s = s.replace(/\bmagnet:\?[^\s"'<>]*/gi, 'magnet:[…]');
  s = s.replace(/\bfile:\/\/[^\s"'<>]*/gi, 'file://[…]');
  // Site only: no path, query, fragment or login.
  s = s.replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@"'<>]*@)?([^\s/?#"'<>]*)[^\s"'<>]*/gi, (m, scheme, host) => `${scheme}://${host}/…`);
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[e-mail]');
  s = s.replace(/[A-Za-z0-9+/_=.-]{40,}/g, '[long value]'); // tokens and keys
  for (const [name, label] of [[user, '[user]'], [pc, '[pc]']]) {
    if (name && name.length >= 3) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'gi'), label);
  }
  return s;
}

module.exports = { redact };
