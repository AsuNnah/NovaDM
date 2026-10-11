'use strict';
// "Update available" notice: asks GitHub which NovaDM release is the newest. Nothing is downloaded
// or installed automatically (the builds aren't code-signed yet); the notice opens the release page.
const REPO = 'https://github.com/AsuNnah/NovaDM/';
const LATEST = 'https://api.github.com/repos/AsuNnah/NovaDM/releases/latest'; // excludes drafts and pre-releases

/** a > b for "x.y.z" versions. */
function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** { version, url } when GitHub has a newer release than `current`, else null. */
async function check(current, fetchText) {
  const r = JSON.parse(await fetchText(LATEST));
  const version = String(r.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, current)) return null;
  const url = String(r.html_url || '');
  return { version, url: url.startsWith(REPO + 'releases/') ? url : REPO + 'releases/latest' };
}

const RELEASES = 'https://api.github.com/repos/AsuNnah/NovaDM/releases?per_page=30';

/**
 * A release's notes (Markdown from the CHANGELOG) as [{ title, items }] of plain text, for showing
 * with textContent. The SmartScreen note and the checksum table at the end are left out.
 */
function cleanNotes(body) {
  const sections = [];
  let cur = null;
  for (const raw of String(body || '').split(/\r?\n/)) {
    if (/^\s*\|/.test(raw) || /^The files are not code-signed/.test(raw)) break;
    const line = raw.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '');
    const head = /^#{2,4}\s+(.*)/.exec(line);
    if (head) { cur = { title: head[1].trim(), items: [] }; sections.push(cur); continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { title: '', items: [] }; sections.push(cur); }
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) cur.items.push(bullet[1].trim());
    else if (/^\s/.test(line) && cur.items.length) cur.items[cur.items.length - 1] += ' ' + line.trim(); // wrapped bullet
    else cur.items.push(line.trim());
  }
  return sections.filter((s) => s.items.length);
}

/** Update preview: the notes of every release newer than `current`, newest first: [{ version, sections }]. */
async function whatsNew(current, fetchText) {
  const list = JSON.parse(await fetchText(RELEASES));
  return (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ version: String(r.tag_name || '').replace(/^v/, ''), sections: cleanNotes(r.body) }))
    .filter((r) => /^\d+\.\d+\.\d+$/.test(r.version) && newer(r.version, current))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1))
    .slice(0, 10);
}

module.exports = { check, newer, LATEST, cleanNotes, whatsNew };
