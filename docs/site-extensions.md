# Site extensions

A site extension teaches NovaDM where a particular site keeps its downloads. When a page on one of
its sites has loaded, NovaDM runs the extension, and whatever it returns appears in the media panel,
marked with the extension's name, ready to download.

## Files

A folder with two files (see `site-extensions/example`):

`novadm-extension.json`

```json
{
  "name": "Example gallery",
  "version": "1.0",
  "description": "What it does, in one line.",
  "matches": ["https://gallery.example.com/*"],
  "script": "index.js"
}
```

- `matches`: the sites the extension works on and may read, as match patterns
  (`https://*.example.com/*`, `*://videos.example.org/watch*`). Patterns for every site
  (`*://*/*`) are refused.
- `script`: the JavaScript file, inside the folder.

`index.js`

```js
novadm.onResolve(async (page) => {          // page: { url, title }
  const html = await novadm.fetchText(page.url);
  // ...find the links...
  return [{ url, name, kind, size, headers }];
});
```

## What the script can use

| | |
|---|---|
| `novadm.onResolve(fn)` | Register the function NovaDM calls for a page. It returns a list (or a promise of one). |
| `novadm.fetchText(url, { headers })` | Page text. Only for addresses matching `matches`; uses the browser's cookies for that site. |
| `novadm.fetchJson(url, { headers })` | The same, parsed as JSON. |
| `novadm.fetch(url, { headers })` | `{ status, url, text }`. |
| `novadm.log(...)` | Writes to NovaDM's log. |

Each item returned: `url` (http, https or magnet; required), `name`, `kind` (`hls`, `dash`, `video`,
`audio` or `file`), `label`, `size` (bytes), `duration` (seconds), `headers` (`referer`, `origin`,
`authorization` or `x-…`). At most 200 items.

## Sandbox

Every run happens in a fresh, hidden page with no Node.js, an empty cookie jar of its own, no
network access (Content-Security-Policy), and no navigation or pop-ups. The only way to the
internet is `novadm.fetch*`, which NovaDM carries out only for the extension's own sites. A run that
takes longer than 20 seconds is stopped.

## Installing

Settings → Site extensions: **Add from a folder…**, or paste a GitHub repository address (its
default branch is downloaded as a zip; `novadm-extension.json` must be at the top). NovaDM shows the
sites the extension can read and asks before installing. Extensions can be switched off or removed
there too.
