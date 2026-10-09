// Example NovaDM site extension. See docs/site-extensions.md.
// Called when a page on gallery.example.com has loaded. Return what can be downloaded.
novadm.onResolve(async (page) => {
  // Pages like https://gallery.example.com/album/42 have a feed at /api/album/42.json
  const m = /\/album\/(\d+)/.exec(new URL(page.url).pathname);
  if (!m) return [];
  const album = await novadm.fetchJson(`https://gallery.example.com/api/album/${m[1]}.json`);
  return album.items.map((it) => ({
    url: it.original,          // the file itself (http, https or magnet)
    name: it.filename,         // optional: file name to save as
    kind: it.video ? 'video' : 'file', // hls | dash | video | audio | file
    size: it.bytes,            // optional
    headers: { referer: page.url }, // optional: referer, origin, authorization, x-...
  }));
});
