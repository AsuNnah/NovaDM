'use strict';
// "Copy as cURL" (browser developer tools) -> a download with the exact same request: address,
// headers, cookies, referer. Handles the bash and Windows cmd forms browsers produce.

/** Split a command line into words (single/double quotes, ^ and \ escapes, line continuations). */
function words(cmd) {
  const s = String(cmd || '').replace(/\^\r?\n|\\\r?\n/g, ' ').trim();
  const out = [];
  let cur = '';
  let i = 0;
  let has = false;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } i++; continue; }
    has = true;
    if (c === "'") { const j = s.indexOf("'", i + 1); cur += s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '$' && s[i + 1] === "'") { // bash $'...' with \' and \\ escapes
      i += 2;
      while (i < s.length && s[i] !== "'") { if (s[i] === '\\' && i + 1 < s.length) { const n = s[i + 1]; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; } else cur += s[i++]; }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if ((s[i] === '\\' || s[i] === '^') && i + 1 < s.length && /["\\^%]/.test(s[i + 1])) { cur += s[i + 1]; i += 2; } else cur += s[i++];
      }
      i++;
      continue;
    }
    if (c === '^' && s[i + 1] === '"') { // Windows cmd form: ^"...^" is a quoted argument
      i += 2;
      while (i < s.length && !(s[i] === '^' && s[i + 1] === '"')) {
        if (s[i] === '\\' && s[i + 1] === '^' && s[i + 2] === '"') { cur += '"'; i += 3; continue; }
        if (s[i] === '^' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
        cur += s[i++];
      }
      i += 2;
      continue;
    }
    if (c === '^' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    cur += c; i++;
  }
  if (has) out.push(cur);
  return out;
}

/** Parse a cURL command. Returns { url, headers, method } or throws. */
function parseCurl(cmd) {
  const w = words(cmd);
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) throw new Error('Paste a command that starts with curl');
  let url = '';
  let method = 'GET';
  const headers = {};
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] || '';
    if (a === '-H' || a === '--header') {
      const h = next();
      const k = h.indexOf(':');
      if (k > 0) {
        const name = h.slice(0, k).trim().toLowerCase();
        const value = h.slice(k + 1).trim();
        if (!['content-length', 'host', 'accept-encoding', 'connection'].includes(name) && !name.startsWith(':')) headers[name] = value;
      }
    } else if (a === '-b' || a === '--cookie') headers.cookie = next();
    else if (a === '-e' || a === '--referer') headers.referer = next();
    else if (a === '-A' || a === '--user-agent') headers['user-agent'] = next();
    else if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form'].includes(a)) { next(); method = method === 'GET' ? 'POST' : method; }
    else if (a === '--url') url = next();
    else if (['-o', '--output', '-u', '--user', '-x', '--proxy', '--max-time', '-m', '--connect-timeout', '-r', '--range', '-w', '--write-out'].includes(a)) next();
    else if (!a.startsWith('-') && !url) url = a;
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('No http(s) address in that command');
  if (method !== 'GET') throw new Error(`This request is a ${method}; only GET requests can be downloaded again`);
  return { url, headers, method };
}

module.exports = { parseCurl, words };
