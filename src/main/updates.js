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

module.exports = { check, newer, LATEST };
