'use strict';
// Known security problems in add-on versions, for "Check for updates" (Settings → About): the installed
// version and the newest one. OSV.dev answers for yt-dlp (PyPI) and Electron (npm); the US NVD for
// FFmpeg and aria2 (by product version). Only a product name and a version number are sent.
const { cmp } = require('./addon-updates');

const OSV = 'https://api.osv.dev/v1/query';
const NVD = 'https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=';
const NUMERIC = /^\d+(\.\d+)*$/;
const RANK = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };

/** "2026.08.19" -> "2026.8.19" (PyPI writes numbers without leading zeros). */
const pypiVersion = (v) => String(v).split('.').map((p) => String(Number(p))).join('.');

/** [{ id, severity }] most severe first, ids as CVE when there is one. */
function tidy(list) {
  const seen = new Set();
  return list.filter((x) => !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0) || a.id.localeCompare(b.id));
}

async function osv(fetchJson, name, ecosystem, version) {
  const j = await fetchJson(OSV, { method: 'POST', body: JSON.stringify({ version, package: { name, ecosystem } }) });
  return tidy((j.vulns || []).filter((v) => !v.withdrawn).map((v) => ({
    id: (v.aliases || []).find((a) => /^CVE-/.test(a)) || v.id,
    severity: String((v.database_specific || {}).severity || '').toUpperCase(),
  })));
}

/**
 * NVD, checked again here: NVD's own match also takes ranges like "git-master before 2025-01-13" and
 * compares dates with version numbers, so only numeric ranges (or the exact version) count.
 */
async function nvd(fetchJson, product, version) {
  const j = await fetchJson(NVD + encodeURIComponent(`cpe:2.3:a:${product}:${version}`));
  const out = [];
  for (const { cve } of j.vulnerabilities || []) {
    const hit = (cve.configurations || []).some((cf) => (cf.nodes || []).some((n) => (n.cpeMatch || []).some((m) => {
      if (!m.vulnerable || !m.criteria.startsWith(`cpe:2.3:a:${product}:`)) return false;
      const exact = m.criteria.split(':')[5];
      if (exact && exact !== '*' && exact !== '-') return exact === version;
      const b = [m.versionStartIncluding, m.versionStartExcluding, m.versionEndIncluding, m.versionEndExcluding];
      if (b.every((x) => x == null) || b.some((x) => x != null && !NUMERIC.test(x))) return false;
      return (m.versionStartIncluding == null || cmp(version, m.versionStartIncluding) >= 0)
        && (m.versionStartExcluding == null || cmp(version, m.versionStartExcluding) > 0)
        && (m.versionEndIncluding == null || cmp(version, m.versionEndIncluding) <= 0)
        && (m.versionEndExcluding == null || cmp(version, m.versionEndExcluding) < 0);
    })));
    if (!hit) continue;
    const m = (cve.metrics && (cve.metrics.cvssMetricV40 || cve.metrics.cvssMetricV31 || cve.metrics.cvssMetricV30 || [])[0]) || null;
    out.push({ id: cve.id, severity: String((m && m.cvssData && m.cvssData.baseSeverity) || '').toUpperCase() });
  }
  return tidy(out);
}

/** The lookup for one add-on version; null when there is no exact version to ask about. */
function lookupFor(id, version) {
  const v = String(version || '');
  if (id === 'ytdlp' && /^\d{4}\.\d+\.\d+/.test(v)) return (f) => osv(f, 'yt-dlp', 'PyPI', pypiVersion(v.match(/^\d{4}\.\d+\.\d+/)[0]));
  if (id === 'electron' && /^\d+\.\d+\.\d+$/.test(v)) return (f) => osv(f, 'electron', 'npm', v);
  if (id === 'aria2' && /^\d+\.\d+\.\d+$/.test(v)) return (f) => nvd(f, 'aria2_project:aria2', v);
  // FFmpeg's official builds: "n9.0.2-24-g…" is release 9.0.2 plus fixes; the newest is only known as "9.0".
  const ff = id === 'ffmpeg' && /^n?(\d+\.\d+\.\d+)(?:[-.]|$)/.exec(v);
  if (ff) return (f) => nvd(f, 'ffmpeg:ffmpeg', ff[1]);
  return null;
}

/**
 * Adds `security` to each add-on item from addon-updates.check:
 * { installed: [{ id, severity }] | null, latest: [...] | null, source, error? }
 */
async function addSecurity(items, fetchJson) {
  const SOURCE = { ytdlp: 'OSV.dev', electron: 'OSV.dev', ffmpeg: 'NVD', aria2: 'NVD' };
  await Promise.all(items.map(async (it) => {
    if (it.error || !SOURCE[it.id]) return;
    const sec = { source: SOURCE[it.id], installed: null, latest: null };
    try {
      const a = it.installed && lookupFor(it.id, it.installed);
      const b = it.latest && it.latest !== it.installed && lookupFor(it.id, it.latest);
      [sec.installed, sec.latest] = await Promise.all([a ? a(fetchJson) : null, b ? b(fetchJson) : null]);
      // The database goes by release number. When the installed release is the newest one, none has a fix yet;
      // fixes made after it on the same branch (the daily builds) are not in the database's picture.
      const base = it.id === 'ffmpeg' && sec.installed && sec.installed.length && it.newestRelease && (/^n?(\d+\.\d+\.\d+)/.exec(it.installed) || [])[1];
      if (base && cmp(base, it.newestRelease) >= 0) {
        sec.note = `${base} is still FFmpeg's newest release, so no release with a fix exists yet. The list goes by release number only: the daily builds of FFmpeg's ${base.split('.').slice(0, 2).join('.')} branch can already contain fixes made after ${base}.`;
      }
    } catch (e) {
      sec.error = e.message;
    }
    it.security = sec;
  }));
  return items;
}

module.exports = { addSecurity, osv, nvd, lookupFor, pypiVersion };
