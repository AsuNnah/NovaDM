# Instructions for Strix: testing NovaDM

NovaDM is a Windows desktop browser and download manager built on Electron (not a web service).
Test the source in this repository. Do not send traffic to any host on the internet; anything you
run must stay on localhost inside your sandbox.

## In scope (NovaDM's attack surface)

- **Web pages reaching NovaDM's own code**: the preload scripts that run in every page
  (`src/main/detect-preload.js`, `src/main/shield-preload.js`, `src/main/siteext-preload.js`) and the
  IPC handlers they can reach (`src/main/browser.js` `novadm:tab`, `src/main/main.js`
  `novadm:password-sent`, `novadm:shield-config`, `novadm:internal-call` / `novadm:internal-settings`,
  which must only answer NovaDM's own `file://…/src/ui/*.html` pages).
- **The toolbar / panel IPC channel** (`src/main/ipc.js`, `novadm:call`): must refuse anything that
  isn't a NovaDM UI page.
- **Untrusted server responses** parsed by the download engine: HTTP headers, HLS / DASH playlists,
  MP4 / TS containers, torrents (`src/main/download/`, `src/main/media/`, `src/main/torrent/`).
- **The local API** (`src/main/api.js`): off by default; 127.0.0.1 only, bearer key, Host check.
- **Site extensions** (`src/main/site-ext.js`): user scripts run in a sandboxed hidden page.
- **Updates and add-on downloads** (`src/main/updater.js`, `src/main/ytdlp.js`, `src/main/ffmpeg.js`,
  `src/main/torrent/aria2.js`): integrity checks before anything runs.
- **NovaDM's own pages** (`src/ui/*.html`, `*.js`): HTML injection from page titles, file names,
  URLs.

## Out of scope

- `tools/` and `test/`: local test scripts and test servers, never shipped.
- `node_modules/`, `dist/`, Electron and Chromium themselves.
- Known and accepted (see `docs/security.md`, "Limits"): malware already running as the Windows user;
  downloading `http://` links the user chose; no Google Safe Browsing.

Report only findings you validated, with the file, the attack path from a web page, a server
response or a local program, and a fix.
