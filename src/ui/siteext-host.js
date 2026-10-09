'use strict';
// Runs one site extension in this sandboxed page and reports what it found.
(() => {
  const host = window.__novadmHost;
  host.onRun(async (job) => {
    let resolver = null;
    const novadm = Object.freeze({
      onResolve(fn) { resolver = fn; },
      async fetchText(url, opts) { const r = await host.fetchText(url, opts); return r.text; },
      async fetchJson(url, opts) { const r = await host.fetchText(url, opts); return JSON.parse(r.text); },
      async fetch(url, opts) { return host.fetchText(url, opts); }, // { status, url, text }
      log(...a) { console.log('[extension]', ...a); },
    });
    try {
      // The extension sees `novadm` and nothing of NovaDM itself.
      new Function('novadm', `"use strict";\n${job.code}`)(novadm);
      if (typeof resolver !== 'function') throw new Error('The extension did not call novadm.onResolve');
      const items = await resolver(Object.freeze({ ...job.page }));
      host.done(JSON.parse(JSON.stringify(items || [])));
    } catch (e) {
      host.fail(e && e.message ? e.message : String(e));
    }
  });
})();
