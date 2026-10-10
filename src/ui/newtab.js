'use strict';
const nav = window.novadmInternal;

const q = document.getElementById('q');
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = q.value.trim();
  if (v && nav) nav.navigate(v);
});

function tick() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}`;
  const h = d.getHours();
  document.getElementById('greet').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
tick();
setInterval(tick, 10000);

async function stats() {
  try {
    if (!nav) return;
    const s = await nav.stats();
    document.getElementById('s-ads').textContent = s.ads || 0;
    document.getElementById('s-pop').textContent = s.popups || 0;
    document.getElementById('s-dl').textContent = s.downloads || 0;
  } catch {}
}
stats();
setInterval(stats, 4000);
