'use strict';
// Find bar (Ctrl+F): searches the page in the active tab.
const api = window.novadm;
const q = document.getElementById('q');
const count = document.getElementById('count');
let last = '';

function search(forward = true) {
  const text = q.value;
  const findNext = text === last && !!text;
  last = text;
  if (!text) { count.textContent = ''; count.classList.remove('none'); }
  api.call('find.query', { text, forward, findNext });
}

q.addEventListener('input', () => search(true));
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (q.value === last) api.call('find.query', { text: q.value, forward: !e.shiftKey, findNext: true }); else search(!e.shiftKey); }
  else if (e.key === 'Escape') api.call('find.close');
  else if (e.key === 'F3') { e.preventDefault(); api.call('find.query', { text: q.value, forward: !e.shiftKey, findNext: true }); }
});
document.getElementById('next').onclick = () => { if (q.value) api.call('find.query', { text: q.value, forward: true, findNext: true }); };
document.getElementById('prev').onclick = () => { if (q.value) api.call('find.query', { text: q.value, forward: false, findNext: true }); };
document.getElementById('close').onclick = () => api.call('find.close');

api.on('find-open', (d) => {
  if (d && typeof d.text === 'string' && d.text) q.value = d.text;
  q.focus();
  q.select();
  if (q.value) { last = ''; search(true); }
});
api.on('find-result', (r) => {
  if (!q.value) { count.textContent = ''; return; }
  count.textContent = r.matches ? `${r.active} of ${r.matches}` : 'No results';
  count.classList.toggle('none', !r.matches);
});
