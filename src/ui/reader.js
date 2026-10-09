'use strict';
// Reader view: the article Mozilla Readability found, cleaned up and shown without the site's
// scripts, ads or layout. The site's HTML is untrusted: only plain text-and-picture elements and a
// few attributes are kept, and it is shown in a sandboxed frame that can't run scripts.
const bridge = window.novadmInternal;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id') || '';

const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'q', 'cite',
  'abbr', 'time', 'a', 'img', 'figure', 'figcaption', 'picture', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'th', 'td', 'caption', 'div', 'span', 'section', 'article', 'header', 'footer', 'aside', 'details', 'summary']);
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], abbr: ['title'], time: ['datetime'] };

function cleanUrl(u, img) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' || x.protocol === 'http:') return x.href;
    if (img && x.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(u)) return u;
  } catch {}
  return '';
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (!KEEP.has(tag)) {
          // Unknown wrappers keep their text; scripts, styles, frames and forms go entirely.
          if (/^(script|style|iframe|frame|object|embed|form|input|button|select|textarea|link|meta|base|svg|math|template|noscript|video|audio|source|track|canvas)$/.test(tag)) child.remove();
          else { walk(child); child.replaceWith(...child.childNodes); }
          continue;
        }
        const allowed = ATTRS[tag] || [];
        for (const a of [...child.attributes]) if (!allowed.includes(a.name.toLowerCase())) child.removeAttribute(a.name);
        if (tag === 'a') { const h = cleanUrl(child.getAttribute('href') || '', false); if (h) child.setAttribute('href', h); else child.removeAttribute('href'); }
        if (tag === 'img') { const s = cleanUrl(child.getAttribute('src') || '', true); if (s) child.setAttribute('src', s); else { child.remove(); continue; } }
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) child.remove();
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let size = 19;
let serif = true;
try { size = Number(localStorage.getItem('readerSize')) || 19; serif = localStorage.getItem('readerSerif') !== '0'; } catch {}

function frameDoc(article) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const css = `
    html{background:${dark ? '#1b1d22' : '#faf8f3'};color:${dark ? '#e3e1dc' : '#22201c'};}
    body{max-width:720px;margin:0 auto;padding:36px 24px 80px;font:${size}px/1.65 ${serif ? "Georgia,'Times New Roman',serif" : "'Segoe UI Variable','Segoe UI',system-ui,sans-serif"};}
    h1.t{font:600 ${Math.round(size * 1.6)}px/1.25 'Segoe UI Variable','Segoe UI',system-ui,sans-serif;margin:0 0 10px;}
    .by{color:${dark ? '#9a978f' : '#6d685e'};font:14px 'Segoe UI',system-ui,sans-serif;margin-bottom:28px;}
    img{max-width:100%;height:auto;border-radius:4px;}
    figure{margin:24px 0;} figcaption{font-size:.8em;color:${dark ? '#9a978f' : '#6d685e'};}
    a{color:${dark ? '#8aa4ff' : '#2c55d6'};}
    pre{overflow:auto;padding:12px;background:${dark ? '#24272e' : '#efebe2'};border-radius:6px;font-size:.85em;}
    blockquote{margin:16px 0;padding-left:16px;border-left:3px solid ${dark ? '#3a3f4b' : '#d8d2c4'};color:${dark ? '#c4c1ba' : '#4a463e'};}
    table{border-collapse:collapse;max-width:100%;overflow:auto;display:block;} td,th{border:1px solid ${dark ? '#3a3f4b' : '#d8d2c4'};padding:4px 8px;}`;
  const by = [article.byline, article.siteName].filter(Boolean).join(' · ');
  return `<!doctype html><html lang="${esc(article.lang)}" dir="${article.dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: http: data:; style-src \'unsafe-inline\';">' +
    `<meta name="referrer" content="no-referrer"><base target="_top"><style>${css}</style></head><body>` +
    `<h1 class="t">${esc(article.title)}</h1>${by ? `<div class="by">${esc(by)}</div>` : ''}${sanitize(article.content)}</body></html>`;
}

let page = null;
function show() {
  if (!page) return;
  $('doc').srcdoc = frameDoc(page.article);
  $('font').textContent = serif ? 'Sans' : 'Serif';
}

async function init() {
  const r = await bridge.call('reader.get', { id });
  if (!r || !r.ok) { document.body.innerHTML = '<div class="msg">This article is no longer available. Go back and open reader view again.</div>'; return; }
  page = r;
  document.title = r.article.title || 'Reader view';
  try { $('site').textContent = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
  show();
}

const store = () => { try { localStorage.setItem('readerSize', String(size)); localStorage.setItem('readerSerif', serif ? '1' : '0'); } catch {} };
$('smaller').onclick = () => { size = Math.max(14, size - 1); store(); show(); };
$('bigger').onclick = () => { size = Math.min(30, size + 1); store(); show(); };
$('font').onclick = () => { serif = !serif; store(); show(); };
$('original').onclick = () => bridge.call('reader.original', { id });
init();
