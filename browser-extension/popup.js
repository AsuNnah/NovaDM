'use strict';
const $ = (id) => document.getElementById(id);
const fmt = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return (b >= 10 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i]; };

$('opts').onclick = () => chrome.runtime.openOptionsPage();

chrome.storage.local.get({ intercept: true }).then((s) => { $('intercept').checked = s.intercept; });
$('intercept').onchange = () => chrome.storage.local.set({ intercept: $('intercept').checked });

chrome.runtime.sendMessage({ type: 'check' }, (r) => {
  const el = $('state');
  if (r && r.ok) { el.textContent = `Connected to NovaDM ${r.version}`; el.className = 'ok'; }
  else { el.textContent = (r && r.error) || 'Not connected'; el.className = 'bad'; }
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  chrome.runtime.sendMessage({ type: 'media', tabId: tab.id }, (r) => {
    const list = (r && r.list) || [];
    const box = $('list');
    if (!list.length) { box.innerHTML = '<div class="empty">No videos found on this page yet. Play the video, then open this again.</div>'; return; }
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'item';
      const name = decodeURIComponent((m.url.split(/[?#]/)[0].split('/').pop() || m.url)).slice(0, 80);
      row.innerHTML = `<span class="tag"></span><span class="u"></span><button>Download</button>`;
      row.querySelector('.tag').textContent = m.kind.toUpperCase();
      row.querySelector('.u').textContent = name + (m.size ? ` · ${fmt(m.size)}` : '');
      row.querySelector('.u').title = m.url;
      const btn = row.querySelector('button');
      btn.onclick = () => chrome.runtime.sendMessage({ type: 'send', item: { url: m.url, referer: tab.url, pageUrl: tab.url } }, (res) => {
        btn.textContent = res && res.ok ? 'Sent' : 'Failed';
        if (!(res && res.ok)) btn.title = (res && res.error) || '';
      });
      box.append(row);
    }
  });
});
