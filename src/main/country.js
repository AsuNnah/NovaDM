'use strict';
// Country profiles (1.8.1, REQ-312–314, SEC-111): a proxy or VPN exit the user has, with the time zone and language
// sites should see. One profile at a time, for the whole app; '' means "your connection" (the normal proxy settings).

// Country -> a usual time zone and language, to fill a new profile; the user can change both.
// shortcut: a hand-picked list of common countries; add a row when someone needs one that isn't here.
const COUNTRIES = {
  AE: ['United Arab Emirates', 'Asia/Dubai', 'ar-AE'], AR: ['Argentina', 'America/Argentina/Buenos_Aires', 'es-AR'],
  AT: ['Austria', 'Europe/Vienna', 'de-AT'], AU: ['Australia', 'Australia/Sydney', 'en-AU'],
  BE: ['Belgium', 'Europe/Brussels', 'nl-BE'], BR: ['Brazil', 'America/Sao_Paulo', 'pt-BR'],
  CA: ['Canada', 'America/Toronto', 'en-CA'], CH: ['Switzerland', 'Europe/Zurich', 'de-CH'],
  CL: ['Chile', 'America/Santiago', 'es-CL'], CN: ['China', 'Asia/Shanghai', 'zh-CN'],
  CO: ['Colombia', 'America/Bogota', 'es-CO'], CZ: ['Czechia', 'Europe/Prague', 'cs-CZ'],
  DE: ['Germany', 'Europe/Berlin', 'de-DE'], DK: ['Denmark', 'Europe/Copenhagen', 'da-DK'],
  EG: ['Egypt', 'Africa/Cairo', 'ar-EG'], ES: ['Spain', 'Europe/Madrid', 'es-ES'],
  FI: ['Finland', 'Europe/Helsinki', 'fi-FI'], FR: ['France', 'Europe/Paris', 'fr-FR'],
  GB: ['United Kingdom', 'Europe/London', 'en-GB'], GR: ['Greece', 'Europe/Athens', 'el-GR'],
  HK: ['Hong Kong', 'Asia/Hong_Kong', 'zh-HK'], HU: ['Hungary', 'Europe/Budapest', 'hu-HU'],
  ID: ['Indonesia', 'Asia/Jakarta', 'id-ID'], IE: ['Ireland', 'Europe/Dublin', 'en-IE'],
  IL: ['Israel', 'Asia/Jerusalem', 'he-IL'], IN: ['India', 'Asia/Kolkata', 'en-IN'],
  IT: ['Italy', 'Europe/Rome', 'it-IT'], JP: ['Japan', 'Asia/Tokyo', 'ja-JP'],
  KR: ['South Korea', 'Asia/Seoul', 'ko-KR'], MX: ['Mexico', 'America/Mexico_City', 'es-MX'],
  MY: ['Malaysia', 'Asia/Kuala_Lumpur', 'ms-MY'], NG: ['Nigeria', 'Africa/Lagos', 'en-NG'],
  NL: ['Netherlands', 'Europe/Amsterdam', 'nl-NL'], NO: ['Norway', 'Europe/Oslo', 'nb-NO'],
  NZ: ['New Zealand', 'Pacific/Auckland', 'en-NZ'], PH: ['Philippines', 'Asia/Manila', 'en-PH'],
  PK: ['Pakistan', 'Asia/Karachi', 'ur-PK'], PL: ['Poland', 'Europe/Warsaw', 'pl-PL'],
  PT: ['Portugal', 'Europe/Lisbon', 'pt-PT'], RO: ['Romania', 'Europe/Bucharest', 'ro-RO'],
  SA: ['Saudi Arabia', 'Asia/Riyadh', 'ar-SA'], SE: ['Sweden', 'Europe/Stockholm', 'sv-SE'],
  SG: ['Singapore', 'Asia/Singapore', 'en-SG'], TH: ['Thailand', 'Asia/Bangkok', 'th-TH'],
  TR: ['Türkiye', 'Europe/Istanbul', 'tr-TR'], TW: ['Taiwan', 'Asia/Taipei', 'zh-TW'],
  UA: ['Ukraine', 'Europe/Kyiv', 'uk-UA'], US: ['United States', 'America/New_York', 'en-US'],
  VN: ['Vietnam', 'Asia/Ho_Chi_Minh', 'vi-VN'], ZA: ['South Africa', 'Africa/Johannesburg', 'en-ZA'],
};
const TYPES = ['http', 'https', 'socks5'];

/** The saved profiles, checked: bad entries are dropped, fields are trimmed and limited. */
function cleanProfiles(list) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').slice(0, 40);
    const server = String(p.server || '').trim().replace(/^[a-z0-9]+:\/\//i, '');
    const timeZone = String(p.timeZone || '');
    if (!/^[\w-]{1,40}$/.test(id) || seen.has(id) || !/^[\w.-]+:\d{1,5}$|^\[[0-9a-f:]+\]:\d{1,5}$/i.test(server) || !validTimeZone(timeZone)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(p.name || '').trim().slice(0, 60) || server,
      country: /^[A-Z]{2}$/.test(p.country) ? p.country : '',
      type: TYPES.includes(p.type) ? p.type : 'http',
      server,
      user: String(p.user || '').slice(0, 200),
      passEnc: typeof p.passEnc === 'string' ? p.passEnc : '',
      timeZone,
      lang: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(p.lang) ? p.lang : 'en-US',
    });
    if (out.length >= 20) break;
  }
  return out;
}

function validTimeZone(tz) {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** The profile in use, or null for "your connection". */
function activeProfile(settings) {
  const id = settings.get('proxyProfile');
  return id ? (settings.get('proxyProfiles') || []).find((p) => p.id === id) || null : null;
}

/** "de-DE" -> "de-DE,de": the language list for one chosen language (Chromium adds the q= weights itself). */
function acceptLanguage(lang) {
  const base = lang.split('-')[0];
  return base === lang ? lang : `${lang},${base}`;
}

/**
 * Make one web tab agree with the profile (null: back to normal), through Chromium's DevTools protocol on that tab,
 * so it takes effect at once and stays across the tab's navigations. Returns false when the tab couldn't be reached
 * (for example another debugger holds it).
 */
async function emulate(wc, profile) {
  if (!wc || wc.isDestroyed()) return false;
  const d = wc.debugger;
  try {
    if (!profile && !d.isAttached()) return true;
    if (!d.isAttached()) d.attach('1.3');
    // Sent together, before anything else is asked of the tab, so a load that starts right after already has them.
    await Promise.all([
      d.sendCommand('Emulation.setTimezoneOverride', { timezoneId: profile ? profile.timeZone : '' }),
      d.sendCommand('Emulation.setLocaleOverride', profile ? { locale: profile.lang } : {}),
      d.sendCommand('Emulation.setUserAgentOverride', { userAgent: wc.getUserAgent(), ...(profile ? { acceptLanguage: acceptLanguage(profile.lang) } : {}) }),
    ]);
    if (!profile) d.detach();
    return true;
  } catch {
    return false;
  }
}

module.exports = { COUNTRIES, TYPES, cleanProfiles, validTimeZone, activeProfile, acceptLanguage, emulate };

/** Cloudflare's /cdn-cgi/trace answer ("ip=…\nloc=…") -> { ip, country }. */
function parseTrace(text) {
  const kv = Object.fromEntries(String(text || '').split(/\r?\n/).map((l) => l.split('=')).filter((a) => a.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
  return { ip: /^[0-9a-f.:]{3,45}$/i.test(kv.ip || '') ? kv.ip : '', country: /^[A-Z]{2}$/.test(kv.loc || '') ? kv.loc : '' };
}

/**
 * "What do sites see" (REQ-314), only when the user presses Check: Cloudflare's trace page through the normal browsing
 * session (so the active route), plus what NovaDM itself sets. fetchFn(url) -> Response; realTz/realLang: the machine's.
 */
async function checkRoute({ fetchFn, profile, webrtcPolicy, realTz, realLang }) {
  let trace = { ip: '', country: '' };
  let error = '';
  try {
    const r = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace');
    trace = parseTrace(await r.text());
    if (!trace.ip) error = 'Cloudflare gave no address';
  } catch (e) {
    error = profile ? `No answer through "${profile.name}"` : 'No answer from Cloudflare';
  }
  return {
    ...trace,
    error,
    profileCountry: profile ? profile.country : '',
    countryMatches: !profile || !profile.country || !trace.country ? null : trace.country === profile.country,
    timeZone: profile ? profile.timeZone : realTz,
    lang: profile ? profile.lang : realLang,
    webrtcProtected: webrtcPolicy === 'disable_non_proxied_udp',
    locationRefused: !!profile,
  };
}

module.exports.parseTrace = parseTrace;
module.exports.checkRoute = checkRoute;
