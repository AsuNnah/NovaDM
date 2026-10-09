'use strict';
// Export and import: the downloads list and the settings, as one JSON file the user keeps
// (for another PC, or a fresh install). Secrets are left out: the proxy password and the API key
// are not exported. Importing adds downloads that aren't in the list yet (finished ones stay
// finished, unfinished ones come back paused) and applies the settings.

const SECRET_SETTINGS = new Set(['proxyPassEnc', 'apiKey']);
const MACHINE_SETTINGS = new Set(['ffmpegPath', 'aria2Path', 'ytdlpPath']); // paths of this PC only

function exportData({ settings, downloads, version, includeSettings = true, includeDownloads = true }) {
  const out = { app: 'NovaDM', format: 1, version, exportedAt: new Date().toISOString() };
  if (includeSettings) {
    out.settings = {};
    for (const [k, v] of Object.entries(settings.data)) if (!SECRET_SETTINGS.has(k) && !MACHINE_SETTINGS.has(k)) out.settings[k] = v;
    // Site sign-in passwords are encrypted for this PC only: not exported.
    if (Array.isArray(out.settings.siteSettings)) out.settings.siteSettings = out.settings.siteSettings.map(({ passEnc, ...s }) => s);
  }
  if (includeDownloads) {
    out.downloads = [...downloads.records.values()].filter((r) => !r.incognito && r.kind !== 'convert').map((r) => ({
      kind: r.kind, name: r.name, savePath: r.savePath, sources: r.sources, playlistUrl: r.playlistUrl, mirrors: r.mirrors,
      headers: stripCookies(r.headers), pageUrl: r.pageUrl, category: r.category, state: r.state === 'done' ? 'done' : 'paused',
      size: r.size, addedAt: r.addedAt, completedAt: r.completedAt, meta: r.meta, queue: r.queue, separateAudio: r.separateAudio,
      magnet: r.magnet, torrentData: r.torrentData, selectFiles: r.selectFiles, expectedHash: r.expectedHash,
      mergeSource: r.mergeSource ? { ...r.mergeSource, tracks: (r.mergeSource.tracks || []).map((t) => ({ ...t, headers: stripCookies(t.headers) })) } : null,
    }));
  }
  return out;
}

// Cookies belong to a sign-in on this PC: not carried in a backup file.
function stripCookies(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (k.toLowerCase() !== 'cookie' && k.toLowerCase() !== 'authorization') out[k] = v;
  return out;
}

/** Apply a backup. Returns { settings: n, added: n, skipped: n }. */
function importData(data, { settings, downloads, applySettings = true, addDownloads = true }) {
  if (!data || data.app !== 'NovaDM' || data.format !== 1) throw new Error('This is not a NovaDM export file');
  const res = { settings: 0, added: 0, skipped: 0 };
  if (applySettings && data.settings && typeof data.settings === 'object') {
    const patch = {};
    for (const [k, v] of Object.entries(data.settings)) if (!SECRET_SETTINGS.has(k) && !MACHINE_SETTINGS.has(k)) patch[k] = v;
    res.settings = Object.keys(settings.set(patch)).length;
  }
  if (addDownloads && Array.isArray(data.downloads)) {
    const known = new Set([...downloads.records.values()].map((r) => keyOf(r)));
    for (const d of data.downloads) {
      if (!d || !['http', 'hls', 'dash', 'merge', 'torrent'].includes(d.kind) || keyOf(d) === '|' || known.has(keyOf(d))) { res.skipped++; continue; }
      downloads.importRecord(d);
      known.add(keyOf(d));
      res.added++;
    }
  }
  return res;
}

function keyOf(r) {
  const src = r.kind === 'torrent' ? (r.magnet || '') : r.kind === 'hls' || r.kind === 'dash' ? (r.playlistUrl || '') : ((r.sources || [])[0] || '');
  return `${src}|${r.savePath || ''}`;
}

module.exports = { exportData, importData };
