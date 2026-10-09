'use strict';
const p = new URLSearchParams(location.search);
const url = p.get('u') || '';
const code = Number(p.get('c') || 0);
const desc = p.get('d') || '';
const $ = (id) => document.getElementById(id);

let host = url;
try { host = new URL(url).host; } catch {}
$('host').textContent = url;
$('code').textContent = desc ? `${desc} (${code})` : `Error ${code}`;
document.title = host;

function show(title, hint, tips) {
  $('title').textContent = title;
  $('hint').textContent = hint;
  for (const t of tips) { const li = document.createElement('li'); li.textContent = t; $('tips').appendChild(li); }
}

if (code <= -200 && code > -300) {
  // Certificate errors. A name mismatch on a site that works elsewhere usually means the
  // network's DNS sent NovaDM to a block page instead of the real site.
  show(`${host} didn't prove its identity`,
    "The security certificate doesn't belong to this site, so NovaDM stopped the connection to keep you safe.",
    [
      'If this site opens in another browser, your network may be redirecting it. In Settings, set Secure DNS to Cloudflare or Google, then try again.',
      'Check that the address is spelled correctly.',
    ]);
} else if (code === -105 || code === -137) {
  show(`Can't find ${host}`, "The site's address couldn't be looked up.",
    ['Check the spelling of the address.', 'Try a different Secure DNS provider in Settings.', 'Check your internet connection.']);
} else if (code === -106) {
  show("You're offline", 'NovaDM can’t reach the internet.', ['Check your Wi-Fi or network cable.', 'Then try again.']);
} else if (code === -7 || code === -118) {
  show(`${host} took too long to respond`, 'The site may be busy or blocked on this network.',
    ['Try again in a moment.', 'Try a different Secure DNS provider in Settings.']);
} else if (code === -102 || code === -101 || code === -100 || code === -15) {
  show(`${host} refused or dropped the connection`, 'The site may be down, or your network may be blocking it.',
    ['Try again in a moment.', 'Try a different Secure DNS provider in Settings.']);
} else {
  show("This page can't be opened", 'Something went wrong while loading this page.', ['Try again.', 'Check the address.']);
}

$('retry').onclick = () => { if (window.novadmInternal && url) window.novadmInternal.navigate(url); };
$('settings').onclick = () => { if (window.novadmInternal) window.novadmInternal.navigate('novadm://settings'); };
