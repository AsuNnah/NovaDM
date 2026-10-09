# NovaDM

A Windows browser and download manager in one app. It has a clean, Brave-style interface, an ad
blocker, a pop-up guard that asks before a site opens a new window, and a media detector that finds
the videos, audio and images on a page so you can download them.

NovaDM is an original project. Its feature set was inspired by Android download managers such as
1DM, and its download engine borrows ideas from open-source desktop managers (Motrix, Gopeed,
AB Download Manager, XDM). No code from any of them is included.

> Status: early development (0.x). See [CHANGELOG.md](CHANGELOG.md) for what each version contains
> and [docs/competitor-research-plan.md](docs/competitor-research-plan.md) for the roadmap.

## Features

### Browser
- Tabs and private tabs, address bar with search (Google, DuckDuckGo, Bing, Brave Search,
  Startpage, Yandex)
- New tab page with a clock and counters for blocked ads, stopped pop-ups and downloads
- Right-click menu: open link in a new or private tab, **Download link with NovaDM**, download
  image/video/audio, copy, search for selected text, inspect
- **Chrome Web Store extensions**: install from the store and use them from the toolbar
- **Secure DNS** (DNS over HTTPS: Cloudflare, Google, Quad9, AdGuard or a custom server), which gets
  around DNS-level blocking by an ISP
- Site permissions (camera, microphone, location, notifications) asked per site
- **History** (Ctrl+H) with search and "Clear browsing data"; private tabs are never recorded
- **Bookmarks**: star in the address bar (Ctrl+D), bookmarks bar, folders, a Bookmarks page
  (Ctrl+Shift+O) with import / export of the HTML file Chrome, Brave, Edge and Firefox use
- **Address bar suggestions** from history and bookmarks; **find in page** (Ctrl+F)
- **Restore tabs**: last time's tabs come back, loading only when clicked
- **Third-party cookies blocked** (can be turned off); optionally clear history, cookies and cache
  when NovaDM closes
- **Theme and accent colour**: like Windows, dark or light, and seven accent colours; size of
  NovaDM's own screens (90–150 %)
- Keyboard shortcuts (Ctrl+T/W/L/J/R/F/D/H, Ctrl+Tab, Alt+arrows) and page zoom with Ctrl + plus / minus / 0

### Ad blocker and pop-up guard
- Ghostery ad-block engine with EasyList, EasyPrivacy and uBlock Origin lists plus the OISD Big
  list, refreshed every 4 days
- Turn blocking off per site from the toolbar shield
- **Pop-up guard**: when a page tries to open a pop-up or a new window, NovaDM asks
  "Open this pop-up?" before anything happens. Pop-ups from known ad domains, and redirects of the
  current tab to ad sites, are blocked outright. You can choose Ask / Block / Allow and keep a list
  of sites that may always open pop-ups.

### Media detection and the content grabber
- Detects video and audio while a page plays: HLS (`.m3u8`), **DASH (`.mpd`)**, MP4/WebM files and
  subtitles, using network sniffing plus a page script that scans `<video>` elements
- A download button appears over playing videos and a media icon lights up in the toolbar
- HLS streams are saved as a single **MP4** (TS segments are converted on the fly, segment by
  segment, so memory use stays flat)
- **Separate picture and sound joined into one MP4 without FFmpeg**: DASH video + audio, and HLS
  streams whose audio is a separate rendition
- **Live stream recording** (HLS): records until you press Stop or the broadcast ends
- **FFmpeg on demand** (optional, Settings → Video tools): verified one-click install of the
  official build, used for WebM/plain-MP4 tracks and for "Save sound only", "Convert sound to MP3"
  and "Repair video"
- **Content grabber**: lists every image on a page (including lazy-loaded and CSS background
  images) with sizes, filters and bulk download
- DRM-protected streams (Widevine) are detected and labelled; NovaDM does not decrypt DRM

### Adding downloads
- **Every download goes through NovaDM**: files a page starts (links, buttons, "attachment"
  answers) are taken over by NovaDM's engine. Links it can't fetch again (`blob:`/`data:`, form
  POST answers) are saved by the browser into the same folders and listed too.
- **New download dialog**: file name, size, folder, a speed limit for this download, an optional
  checksum to verify, "Add paused", and a warning when the same link is already in the list. It
  can be turned off ("start downloads right away").
- **Copied links**: copy a link to a file type on your list in any app, and NovaDM offers to
  download it.
- **Several at once**: paste many links, or a pattern like `https://site/img[001-120].jpg` or
  `file[a-f].zip`, and pick which to download.
- **"Copy as cURL"**: paste a command from a browser's developer tools and the download uses the
  same headers and cookies.
- **Category rules**: by file type, site or address text, each with its own folder if you like.
- Videos from the media button and images from the grabber start right away.

### Download manager
- Multi-connection HTTP downloads (up to 32 connections) with pause, resume and retry.
  Connections are added while they still make the download faster (slow start), and slow parts
  get help near the end.
- **More than 6 connections per server**: where the browser would stop at 6, NovaDM opens the rest
  with its own HTTP client, keeping the browser's cookies, Referer, Secure DNS and proxy. Servers
  that refuse it get the browser's connections automatically.
- **Crash-safe**: progress is saved only after the data is synced to disk, so a crash or power cut
  resumes from the last checkpoint; a file that changed on the server is detected on resume.
- HLS downloads with parallel segments, pause and resume (the MP4 timeline stays continuous). AES
  keys and the playlist are kept, so a paused stream still resumes after its links expire.
- Clear errors for full disks, expired links and servers that limit connections (429/503 are
  retried after the time the server asks for)
- **Refresh link**: when a link expires, open the download's page and start it (or play the
  video) again, and NovaDM continues the old download from the new link. You can also paste a new
  link. What was already downloaded is kept.
- **Notifications** when a download finishes or fails; click to open it
- **Resume unfinished downloads when NovaDM starts** (optional); quitting pauses downloads cleanly
- Speed limit for all downloads and for each download (also changeable while it runs)
- **Checksum check**: give an MD5, SHA-1 or SHA-256 when adding, and NovaDM verifies the file
- **Proxy** for browsing and downloads: Windows settings, none, HTTP/HTTPS/SOCKS server, or a PAC
  script, with sign-in (the password is encrypted by Windows)
- Downloads from private tabs use the private session and are not kept in the list
- **Settings for a site**: connections, speed limit, browser name (user agent) and a sign-in
  (password encrypted by Windows)
- **Export / import** the downloads list and settings (passwords, keys and cookies are never
  exported)

### After a download
- **Unpack archives** (zip, 7z, rar, tar…) into a folder next to them, optionally deleting the
  archive; or "Extract here" from the Downloads menu
- **Start a program** with the file as an argument (`"{file}"`, `{folder}`, `{name}`, `{url}`,
  `{page}`), started directly without a command shell
- **Webhook**: a JSON POST to your address when a download finishes or fails

### Other browsers and apps
- **Browser extension for Chrome, Edge and Brave** (`browser-extension/`, load it unpacked):
  right-click "Download with NovaDM", send the browser's downloads to NovaDM (with its cookies),
  and see the videos found on a page
- **Local connection for other apps** (off by default; 127.0.0.1 only, with a key), including an
  **MCP endpoint** (`/mcp`) so AI assistants can add and manage downloads
- **Command line and links**: `NovaDM.exe --add <link> [--name <file>] [--start]`,
  `novadm://add?url=…`, magnet links and `.torrent` files
- **Site extensions**: small sandboxed scripts that find a site's downloads
  ([guide](docs/site-extensions.md))
- **yt-dlp add-on** (optional): "Find with yt-dlp" for over a thousand sites; NovaDM does the
  downloading and joins separate picture and sound

### Torrents
- **BitTorrent and magnet links** (through aria2, installed on demand or your own aria2c.exe):
  magnet links from pages, the clipboard or the Downloads box, `.torrent` links and files
- Choose which files to download; seeding with a ratio / time limit and "Stop seeding"; DHT, peer
  exchange and an up-to-date public tracker list

### Background, scheduling and safety
- **Tray icon**: closing the window while downloads run keeps NovaDM downloading in the tray;
  optionally always stay in the tray and **start with Windows**
- **Queues and schedules**: named queues with their own "at once" limit and a time window
  (start, optional end, days of the week); downloads pause when the window ends and continue in
  the next one
- **When all downloads finish**: close NovaDM, sleep or shut down, after a cancellable countdown
- Keeps the computer awake while downloading
- **Microsoft Defender scan** of finished programs and archives (or all files), with the result in
  the list
- **Mark of the Web** on downloaded files, so Windows SmartScreen and Office Protected View treat
  them like browser downloads
- Downloads page in the style of 1DM: category tabs, search, bulk actions, progress, speed and
  time left, and a box to paste a link (file or `.m3u8` stream)
- **Properties** for each download: page and download links, mirrors, save path, resume support,
  size, average speed, dates, active time, parts, connections, speed limit, checksum check, and
  MD5 / SHA-256 checksums; "Download again" and "Refresh link"
- Maximum active downloads, category folders, file names from page titles

## Running from source

Requirements: Windows 10/11 and [Node.js](https://nodejs.org/) 22 or newer.

```bash
npm install
```

```bash
npm start
```

After `npm install` you can also double-click `Start NovaDM.cmd`.

## Building the installer

```bash
npm run dist
```

This writes `NovaDM-Setup-<version>.exe` (installer) and `NovaDM-Portable-<version>.exe` to
`dist/`. The builds are not code-signed, so Windows SmartScreen may warn on first run.

## Tests

```bash
npm test
```

Unit tests cover the HLS parser, media classification, the media registry, TS→MP4 conversion, the
HTTP and HLS download engines and the direct HTTP client (against local test servers), and the
content grabber.

`tools/` holds in-app self-tests (`selftest-*.js`) and diagnostics. They run inside Electron
with a throwaway profile, for example:

```bat
set NOVADM_USERDATA=%TEMP%\novadm-test-profile
set NOVADM_SELFTEST=tools/selftest-popup.js
node_modules\electron\dist\electron.exe .
```

Other debug variables: `NOVADM_OPEN=<url>` opens a page at start-up instead of the new tab, and
`NOVADM_PANEL=<name>` opens a toolbar panel.

## Project layout

```
docs/                     design notes and the roadmap
src/main/                 Electron main process
  main.js                 window, views, layout, app start-up
  browser.js              tabs (one WebContentsView per tab)
  browsing.js, library.js history, bookmarks, find bar, restore tabs, address-bar suggestions
  adblock.js, popup.js    ad blocker and pop-up guard
  dns.js                  Secure DNS
  extensions.js           Chrome extensions and Web Store
  grabber.js              content (image) grabber
  media/                  media detection, HLS and DASH parsing, TS→MP4, MP4 track merger
  download/               download manager, HTTP and HLS engines, speed limiter
  transport.js            NovaDM's own HTTP client for extra connections (undici)
  add-flow.js             how downloads get added: dialog, duplicates, link lists, Refresh link
  clipboard-watch.js      copied-link watcher
  proxy.js, notify.js     proxy settings and sign-in; Windows notifications
  scheduler.js            download queues and their time windows
  background.js           tray, start with Windows, keep awake, "when all downloads finish"
  ffmpeg.js               FFmpeg on demand (verified install, joining, sound, repair)
  torrent/                aria2 helper (install, start, JSON-RPC, trackers), .torrent reader
  api.js                  local API and MCP endpoint for other apps; command line and novadm:// links
  curl.js, backup.js      "Copy as cURL" parser; export / import
  rules.js, hooks.js      category rules and per-site settings; after-download program and webhook
  site-ext.js             site extensions (install, sandboxed runs, site-limited fetching)
  ytdlp.js                yt-dlp add-on (verified install, choices from yt-dlp -J)
browser-extension/        the Chrome / Edge / Brave extension
site-extensions/example/  an example site extension
src/ui/                   toolbar, panels, downloads, settings, new tab pages
test/                     unit tests (node --test)
tools/                    self-tests, diagnostics, icon generator
assets/                   app icon
```

## Privacy

NovaDM has no telemetry and no accounts. Everything it stores (settings, the downloads list, tabs,
history, bookmarks, extensions, cookies) stays in `%APPDATA%\NovaDM` on your computer. The only network requests it makes
on its own are ad-block list updates and Secure DNS lookups to the provider you choose.

The clipboard watcher only checks copied text for download links while NovaDM runs; nothing is
saved or sent, and it can be turned off. Downloads from private tabs are not written to the list.
Proxy and site passwords are stored encrypted with Windows' data protection. The webhook and the
after-download program only run if you set them up.

Profiles from the earlier name of this project ("Swoop") are moved to `%APPDATA%\NovaDM`
automatically on first start.

## License

No license has been chosen yet; all rights reserved. Note that NovaDM uses
[electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), which is
GPL-3.0, so any public release must be GPL-3.0 compatible.
