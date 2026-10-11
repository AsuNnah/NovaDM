'use strict';
// Reading a Chrome extension's manifest.

// Manifest V3 blockers (uBlock Origin Lite, AdGuard…) hand their rules to Chrome through
// declarativeNetRequest. Electron has no such API, so they load but block nothing.
const usesDnr = (m) => !!m && [...(m.permissions || []), ...(m.optional_permissions || [])].some((p) => typeof p === 'string' && /^declarativeNetRequest/.test(p));
const optionsPageOf = (m) => (m && (m.options_page || (m.options_ui && m.options_ui.page))) || '';

module.exports = { usesDnr, optionsPageOf };
