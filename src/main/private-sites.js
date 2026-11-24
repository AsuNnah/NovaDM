'use strict';
// Guard switches changed in a private window (Guard off, Guard Extended off, always block or allow pop-ups): kept in
// memory for private tabs only and dropped when the private window closes; never written to settings (AU-12).
const over = new Map(); // settings key -> Map(site -> in that list for private tabs?)

/** Is `site` in the settings list `key`, as private (incognito) or normal tabs see it? */
function listHas(settings, key, site, incognito = false) {
  const m = incognito && over.get(key);
  if (m && m.has(site)) return m.get(site);
  return (settings.get(key) || []).includes(site);
}

function setPrivate(key, site, on) {
  if (!over.has(key)) over.set(key, new Map());
  over.get(key).set(site, on);
}

function clear() { over.clear(); }

module.exports = { listHas, setPrivate, clear };
