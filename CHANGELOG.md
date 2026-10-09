# Changelog

All notable changes to NovaDM are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org/); each released version has a matching git tag
(`v0.1.0`, …), so you can go back to it with `git checkout v0.1.0`.

## [Unreleased]

- NovaDM is licensed under the GNU GPL, version 3 or later (`LICENSE`). Before this it had no
  license. GPL-3.0 is required by electron-chrome-extensions, which NovaDM uses under its GPL-3.0
  option.

## [1.2.3] — 2026-10-09

### Fixed
- **Cloudflare "Verify you are human" pages looping.** Two causes:
  - The User-Agent *header* of page requests still said `NovaDM/… Electron/…`, while scripts saw a
    plain Chrome name (a 0.1 bug: only the scripts' name was cleaned). Every request now has the
    plain Chrome name.
  - Standard fingerprinting protection changed the CPU count, memory and screen size that pages
    see, but background scripts (workers) still saw the real ones, and the changed values were
    detectable. Bot checks treat that as a sign of automation. Standard now only adds noise to
    canvas and audio read-outs (like Brave). The fixed values, the hidden device APIs and the WebGL
    name moved to Strict, which is allowed to break such checks.
  - Cloudflare, hCaptcha and reCAPTCHA check frames get no fingerprinting changes.
  - If a site still loops, turn "Tor-style protection" off for it in the shield panel.

### Notes
- **Windows Firewall question on first use:** it appears when a page uses WebRTC (video calls,
  and many tracking and bot-check scripts), because Chromium then opens a UDP port on the network.
  NovaDM itself opens no ports (the local API listens on this PC only, and is off by default).
  Choosing "Cancel" / blocking is fine: calls still work, through outgoing connections.

### Tests
- 127 unit tests. In-app: the request header and page agree on the browser name; page and worker see
  the same CPU and memory with Standard; Strict still applies the fixed values. Self-tests for
  per-site browser names, downloads, transport, pop-ups and 1.2 pass.

### Not verified here
- No real Cloudflare challenge page was loaded in the tests. Please try the site that looped.

## [1.2.2] — 2026-10-09

### Added
- **Search in Settings**: a search box at the top filters the settings by their name, help text and
  the choices in their lists (e.g. "cloudflare" finds Secure DNS); a section name shows the whole
  section.
- **Add-ons section**: aria2, FFmpeg and yt-dlp are together under "Add-ons (installed
  separately)", with a note that they are separate programs NovaDM only downloads when you click
  Install. Each one that isn't installed says what doesn't work without it (⚠ in orange). Torrents
  point to the aria2 add-on.
- **Installer: shortcuts page.** Tick "Create a desktop shortcut" and/or "Add NovaDM to the Start
  menu" (both ticked by default). Updates keep the shortcuts you have; silent installs (`/S`)
  create both.

### Fixed
- After installing an add-on, Settings kept showing "Installing…" (with a Remove button) until the
  page was opened again: the status read right after the install still said "installing".

### Tests
- 127 unit tests pass. In-app check of the Settings page: the three "not installed" warnings,
  searches for "proxy", "cloudflare", "torrent", a word that matches nothing ("No settings match")
  and an empty search (all 64 settings back).

### Not verified here
- The installer was built (the shortcuts page compiles), but not run on this PC, since installing
  would create shortcuts and an uninstall entry on the real system.

## [1.2.1] — 2026-10-09

Code review and clean-up: 328 lines removed, 68 added, no feature changed.

### Fixed
- **Fingerprinting noise (Standard) sometimes did nothing.** About half of NovaDM starts left
  canvas exports unchanged, so a site could still read the real canvas fingerprint. Two causes,
  depending on the random per-start key: noise of 0 was possible, and noise written into transparent
  pixels was lost (canvases store premultiplied alpha). The changed pixels now always change. Found
  when the 1.2 self-test failed after the clean-up; the self-test now passes 5 runs out of 5.

### Removed (unused)
- 11 IPC methods nothing called: `window.isMaximized`, `nav.stop`, `media.state`, `popup.setMode`,
  `settings.set`, `settings.setProxyPassword`, `settings.chooseDownloadDir`, `clipboard.read`,
  `util.copy`, `bookmarks.move`, `tabs.unload`. The Settings page uses its own bridge for these.
- The `askBeforeExternalApps` setting (never read: NovaDM always asks), the unused bookmark
  reordering, an unused MP4 constant, and the "window-state" event that the toolbar ignored.
- Old one-off scripts from 0.1: `tools/try-download.js`, `try-resume.js` (covered by the unit tests),
  `check-electron.js`, `check-headers.js` (covered by the transport and phase 2 self-tests).
- Unused imports.

### Changed
- `main.js` and `ipc.js` load their modules once at the top instead of in about 30 places.
- The live-recording progress in the merge engine is shared with the normal progress.

### Tests
- 127 unit tests pass. All in-app self-tests pass (phases 2–7, downloads, transport, menu, pop-ups,
  speed, live DASH, 1.0 and 1.2 with restarts).

## [1.2.0] — 2026-10-09

Brave's keyboard shortcuts and Tor-style protections for normal tabs. Private browsing in Tor
Browser (`docs/v1.2-plan.md` §1) is on hold.

### Added
- **Keyboard shortcuts** (Brave / Chrome set; Ctrl+/ shows the list):
  - Ctrl+Shift+T reopens the last closed tab, back where it was.
  - Ctrl+N opens a new tab and Ctrl+Shift+N a private tab. Ctrl+Shift+W closes the window.
  - Ctrl+1…8 / Ctrl+9, Ctrl+PgUp / PgDn switch tabs.
  - Alt+D, F6, Ctrl+K and Ctrl+E go to the address bar. There, Ctrl+Enter adds www. and .com and
    Alt+Enter opens in a new tab.
  - Shift+F5 / Ctrl+Shift+R reload without cache. Esc stops loading. Alt+Home goes home. F11 is
    full screen.
  - Ctrl+P prints, Ctrl+S saves the page through NovaDM's downloader, Ctrl+O opens a file.
  - Ctrl+Shift+D bookmarks all tabs. Ctrl+Shift+Delete clears browsing data.
  - F12 / Ctrl+Shift+I / J / C open developer tools. Ctrl+U shows the page source.
  - Shift+Esc opens a task manager: memory per tab, and unloading background tabs.
  - Alt+F / F10 open the menu. Ctrl+wheel zooms. **Alt+click** downloads a link with NovaDM.
  - All of them also work while the toolbar has the keyboard (one shared list, `shortcuts.js`).
- **Fingerprinting protection** (Settings → Privacy, on by default):
  - Standard, like Brave: canvas, WebGL and audio read-outs get tiny noise that differs per site and
    per NovaDM start. CPU count, memory and screen size read the same for everyone. The battery,
    USB, HID, serial, Bluetooth and network-information APIs are gone.
  - Strict, like Tor Browser: canvas read-outs come back blank, WebGL is off and audio read-outs are
    silent.
- **WebRTC** no longer reveals local network addresses (calls still work).
- **Security level** (Tor Browser's levels):
  - Safer: no JIT compiler (applies after a restart), JavaScript off on http:// sites, no web fonts,
    audio and video play only when clicked, strict fingerprinting.
  - Safest: JavaScript off everywhere.
- **Shields panel: "Tor-style protection"** on/off per site, for a site that breaks. The page
  reloads. The JIT part of Safer can't be turned off per site.

### Changed
- The toolbar's own key handling was replaced by the shared shortcut list. Ctrl+Shift+R now
  reloads without the cache (it did a normal reload).

### Cost (measured in the 1.2 plan, offline test pages)
- Standard fingerprinting: +13 ms on a page that fingerprints (25 → 42 ms for the fingerprinting
  script). The page itself is unchanged within noise.
- Strict: 17 ms faster on such a page. Same values for everyone: no measurable cost.
- Safer:
  - JIT off: about 2× script time (app work 71 → 162 ms, news page 238 → 549 ms). WebAssembly is off.
  - Click-to-play: a video page 255 → 95 ms load and 156 → 30 ms CPU.
- Safest: JavaScript off, 238 → 196 ms load (most sites break).

### Tests
- 127 unit tests (new: the shortcut list incl. keys that must stay with the page, protection
  levels and per-site off, and a syntax check of every UI and preload script: a broken UI script
  only showed up as a blank panel in the running app).
- In-app self-test `tools/selftest-v12.js`, two runs:
  - **Fingerprinting:** noise the same within a site, different across sites and from the real
    values; same-for-everyone values; Strict blocks WebGL and canvas; the per-site switch gives the
    real values back.
  - **Levels:** Safer (no scripts on http, no fonts, no autoplay); Safest (no scripts).
  - **Shortcuts:** Ctrl+Shift+T, Ctrl+1, Ctrl+U, F12, Ctrl+Shift+D, Ctrl+T from the toolbar;
    Alt+click download.
  - **After a restart with Safer:** the JIT compiler is off.

### Not verified here
- Printing and full screen were not exercised by a test (they open the system print dialog and
  change the window).

## [1.1.0] — 2026-10-09

Speed, in the way Brave gets it (less work per page; same Chromium engine underneath), reader view,
and live DASH recording.

### Added
- **Live DASH recording** (the last open item of the video roadmap): live MPEG-DASH streams are
  recorded like live HLS: "Record" in the media panel, "● Recording" with the recorded time in
  Downloads, Stop finishes the file. Works with numbered segments (timed from the stream's start
  time) and with segment timelines; the recording starts a few seconds before the live edge on
  picture and sound alike. The file is finished when you press Stop, when the broadcast ends (the
  manifest turns static or a new programme period starts), or when nothing new arrives for a
  while. Separate picture and sound are joined into one MP4 without FFmpeg.
- **Skip tracking redirects**: links through google.com/url, l.facebook.com, youtube.com/redirect,
  Bing, DuckDuckGo, LinkedIn, Reddit, Steam, VK and others go straight to the page; the tracker is
  never contacted.
- **Remove tracking codes from addresses**: fbclid, gclid, msclkid and ~30 similar click
  identifiers (campaign names like utm_* are kept).
- **Open the original page instead of AMP**: Google AMP addresses and AMP pages open on the
  publisher's own site; the AMP copy is left out of the back list.
- **Use HTTPS when the site supports it**: http:// links open over HTTPS; a site without working
  HTTPS opens over http again (remembered until NovaDM closes), as do sites that send visitors back
  to http, local addresses and addresses with a port.
- **Unload inactive tabs** (Settings → Tabs, after 30 minutes by default): background tabs give
  back their memory and CPU and stay in the tab strip (dimmed); clicking one brings it back with
  its back/forward list, scroll position and form values. Tabs playing sound are kept.
- **Reader view**: a book icon in the address bar on article pages (and in the menu) shows just the
  article (Mozilla Readability), with text size and serif / sans-serif choices. The site's HTML is
  cleaned (only text, pictures and links kept) and shown in a sandboxed frame without scripts.
- **Benchmark** `tools/bench-pageload.js`: an offline "fake web" (news pages loading scripts from
  the real ad and tracker domains, which do work like real ads) or your own list of pages.

### Changed
- Shields rules apply from the first page after start (before the filter lists have loaded).
- The page scan for video links runs at most every 2 s and only when the page is idle (it re-ran
  600 ms after every change, which costs CPU on busy pages).

### Measured (offline fake web, median of 3 rounds × 4 pages)
| | Load | CPU of the page | Requests |
|---|---|---|---|
| Ad blocking off | 779 ms | 1062 ms | 32 |
| Ad blocking on | 178 ms | 29 ms | 2 |
| On, without element hiding | 178 ms | 27 ms | 2 |
- Element hiding costs ~2 ms per page, so there was nothing to cut there.
- The filter engine needs ~7 µs per request (20,000 requests in 142 ms). **Decision: keep the
  Ghostery engine**; Brave's adblock-rust could not make pages noticeably faster (and needs a Rust
  build for every Electron version).
- 8 open tabs: 1240 MB of page memory; with 7 of them unloaded: 490 MB.

### Fixed
- Reader view no longer waits forever on a page that has a dialog open (gives up after 10 s).

### Tests
- 124 unit tests (new: redirect skipping incl. Bing's encoded links, tracking codes, AMP addresses,
  HTTPS upgrade with fallback, local addresses and redirect loops; live DASH segments from the
  clock and from a timeline, static timelines unchanged).
- In-app self-test `tools/selftest-speed.js`: each rule on a real navigation, HTTPS upgrade through a
  local proxy (a site without HTTPS falls back, one with HTTPS stays), a tab unloaded and brought
  back at scroll position 2000 with its back list, reader view without scripts / event handlers /
  `javascript:` links, video links still found.
- In-app self-test `tools/selftest-livedash.js`: a local live DASH server (real fragmented MP4 video
  and audio); recording, Stop, the file plays in Chromium with picture and sound; a broadcast that
  ends by itself finishes the file.
- All earlier self-tests (phase 2–7, downloads, transport, menu, pop-ups, 1.0) pass unchanged.

### Not verified here
- The speed figures come from the offline fake web, not from real sites; run the benchmark with
  `NOVADM_BENCH_URLS` for your own pages.
- Live DASH was tested against a local server, not a real broadcaster.

## [1.0.0] — 2026-10-09

Everyday browsing: the browser features the 1DM feature map still had open. Plan for 1.x:
`docs/v1-plan.md`.

### Added
- **History** (Ctrl+H, `novadm://history`): pages by day, search, open, remove single pages or a
  selection. Kept 90 days. Private tabs are never recorded.
- **Clear browsing data**: history for the last hour / day / week / all time, and cookies and site
  data or cached files (all time).
- **Bookmarks**: star in the address bar (Ctrl+D), **bookmarks bar** under the toolbar (shown once
  there are bookmarks; Ctrl+Shift+B), folders as menus, a » menu for those that don't fit,
  right-click to open in a new or private tab, edit or delete. **Bookmarks page** (Ctrl+Shift+O):
  rename, change address, move to a folder, delete, and **import / export** of the HTML bookmarks
  file that Chrome, Brave, Edge and Firefox use. The site's icon is kept with the bookmark.
- **Address bar suggestions** from history and bookmarks as you type (arrow keys, Enter, click).
- **Find in page** (Ctrl+F): matches counted as you type, Enter / Shift+Enter or F3 / Ctrl+G for
  next / previous, Esc closes.
- **Restore tabs**: the tabs from last time come back (saved as you browse, so also after a crash
  or power cut). Only the tab you were on loads at start; the others load when clicked. Private
  tabs are never kept.
- **Block third-party cookies** (on by default, like Brave): sites embedded in other sites can't
  keep cookies there, through headers or scripts. Uses Chromium's own switch, so a change takes
  effect after NovaDM restarts.
- **When NovaDM closes, clear** history, cookies and site data, and/or cached files.
- **Size of NovaDM's screens** (90–150 %): toolbar, menus, find bar and NovaDM's own pages.

### Fixed
- NovaDM's own pages opened with an address query (the error page) showed a `file:` path in the
  address bar instead of nothing.

### Tests
- 119 unit tests (new: history merging, search, suggestions, clearing by time and the 90-day
  limit; bookmarks toggle / edit / move, import of a Chrome-style file with folders, export and
  re-import; saved tabs).
- In-app self-test `tools/selftest-v1.js`, two runs on one profile: history with titles and none
  from private tabs, suggestions, star → bar (toolbar 88 → 120 px), find "1 of 3" → "2 of 3",
  History page, 125 % size, third-party cookies blocked (header and `document.cookie`, against a
  local HTTPS server with a throwaway certificate given in `NOVADM_TLS_DIR`), then after a restart:
  the same tabs, only the active one loaded, history cleared on exit, bookmarks kept. The pop-up
  self-test passes on this release; the other earlier self-tests were run on the 1.1.0 code (which
  contains everything here) and pass unchanged.

## [0.8.0] — 2026-10-09

Extras (roadmap phase 7, the last phase of the plan).

### Added
- **Paste a "Copy as cURL" command** into the Downloads box (from a browser's developer tools,
  bash or Windows form): the download uses the same address, headers, cookies and referer. POST
  requests are refused with an explanation, since they can't be fetched again.
- **Export and import** (Downloads → Export / Import): the downloads list and settings in one JSON
  file. Passwords, the API key, cookies and sign-in headers are never exported; paths to programs
  on this computer (FFmpeg, aria2, yt-dlp) are left out; unfinished downloads come back paused;
  downloads already in the list are skipped.
- **Category rules** (Settings → Rules): by file type, site or text in the address, each with a
  category and optionally its own folder. The first matching rule wins; the New download dialog
  shows the folder it picks.
- **Settings for a site** (Settings → Rules): connections, a speed limit, a browser name (user
  agent) and a sign-in for one site and its subdomains. The sign-in answers the site's password
  request (Basic/Digest) in downloads and while browsing; the password is encrypted by Windows and
  never sent to NovaDM's own pages.
- **Unpack archives** after a download (Settings → After a download, or "Extract here" in the
  Downloads menu): zip, 7z, rar, tar(.gz/.bz2/.xz/.zst), cab and iso go into a folder next to
  them, with Windows' own `tar.exe` (older Windows 10 builds read fewer formats). Files Microsoft
  Defender reported are never unpacked. Optionally deletes the archive afterwards.
- **After a download: start a program** with arguments like `"{file}"` `{folder}` `{name}`
  `{url}` `{page}`. The program is started directly, never through a command shell, and `.bat` /
  `.cmd` files are refused.
- **Webhook**: a JSON note (POST) to an address of your choice when a download finishes or fails
  (name, file, size, link, page, error).
- **MCP endpoint for AI assistants** at `http://127.0.0.1:<port>/mcp`, part of the local connection
  (off by default, same key): tools to add, list, check, pause, resume and remove downloads.
- **Theme and accent colour** (Settings → Appearance): like Windows / dark / light for NovaDM and
  the pages it shows, and seven accent colours for NovaDM's own screens.
- **Keyboard shortcuts while a page has the keyboard**: Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+J
  (Downloads), Ctrl+R / F5, Ctrl+Tab / Ctrl+Shift+Tab, Alt+Left / Right, and **page zoom** with
  Ctrl + plus / minus / 0 (for every page of that site).

### Changed
- Highlights in the Downloads page, media panel and toolbar follow the accent colour.

### Not done
- **Auto-update** (A18): it needs signed builds and a public place to download them from; the
  repository is private and the builds are unsigned, so updates stay manual.
- A size setting for NovaDM's own screens and more languages (rest of A18).

### Tests
- 115 unit tests (new: cURL parsing incl. the Windows `^"` form, export/import without secrets,
  category rules and site matching, program arguments without a shell, webhook, unpacking with
  `tar.exe`, MCP requests).
- In-app self-test `tools/selftest-phase7.js`: theme and accent applied, Ctrl+= / Ctrl+0 / Ctrl+T
  inside a page, a cURL command's cookie and referer reaching the server, a rule's folder, a site's
  browser name / single connection / sign-in, a zip unpacked, the program and webhook run, export
  and import, and the MCP tool list. All earlier self-tests pass unchanged.

## [0.7.0] — 2026-10-09

Other browsers and apps (roadmap phase 6).

### Added
- **Browser extension for Chrome, Edge and Brave** (folder `browser-extension`; Settings → Other
  browsers and apps → "Show the extension folder", then "Load unpacked" in the browser):
  - right-click "Download link with NovaDM" / "Download with NovaDM" on videos, sounds and images
  - optionally sends the browser's own downloads to NovaDM (file types, minimum size, sites to
    leave alone); the browser's cookies and the page go along, so sign-in downloads work. If
    NovaDM isn't running, the browser downloads the file itself as usual.
  - the toolbar button lists videos and streams (HLS, DASH, MP4…) seen on the page, with a count
- **Local connection for other apps** (off by default): a small API on 127.0.0.1 with a key
  (copy / renew in Settings). Requests from web pages and other host names are refused. Adds,
  lists, pauses, resumes and removes downloads; added links show the New download dialog unless
  the caller asks to start.
- **Command line and links**: `NovaDM.exe --add <link> [--name <file>] [--start]`, `novadm://add?url=…`
  links (always with the dialog), magnet links and `.torrent` files passed to NovaDM; a second start
  hands them to the running NovaDM. The installer registers `novadm://` and `.torrent`; Settings can
  make NovaDM the program for magnet links.
- **Site extensions**: small scripts that find a site's downloads (results in the media panel).
  Installed from a folder or a GitHub repository after showing which sites they can read; each run
  happens in a fresh sandbox without Node, cookies or network, and can only fetch from its own
  sites through NovaDM. Guide: `docs/site-extensions.md`, example in `site-extensions/example`.
- **yt-dlp add-on** (optional, Settings → Video tools): "Find with yt-dlp" in the media panel asks
  yt-dlp what a page offers and shows a short list (complete files, streams, best picture + sound,
  sound only); NovaDM's engines do the downloading, separate picture and sound are merged (without
  FFmpeg for MP4 + M4A). Installed from the official release and checked against its published
  SHA-256 list. The page's cookies go to yt-dlp in a temporary file that is deleted right after.
  Each site's own terms apply.

### Fixed
- A DASH stream given as one big file per track was read into memory in one piece. Such files are
  now split by their own index (no FFmpeg needed), or into 4 MB parts that FFmpeg joins; a server
  that ignores part requests is refused instead of being read whole.

### Tests
- 108 unit tests (new: local API incl. web-page and DNS-rebinding refusal, command line and
  novadm:// links, cookies limited to their site, the browser extension's code against the real
  API with a stand-in browser, yt-dlp choices / checksums / cookie file, site extension patterns,
  manifests, sandbox fetch rules, direct separate tracks).
- In-app self-test `tools/selftest-phase6.js`: API, links and command line, a site extension in the
  real sandbox (its own fetch() blocked, other sites refused), yt-dlp choices with the merged file
  played in Chromium with picture and sound. All earlier self-tests pass unchanged.

### Not verified here
- The extension was not loaded into a real Chrome/Edge/Brave (its code was run against the real
  API with a stand-in for the browser's extension API). yt-dlp itself was not run (stand-in).

## [0.6.0] — 2026-10-09

Torrents and magnet links (roadmap phase 5).

### Added
- **BitTorrent and magnet links** through aria2 (the engine Motrix uses), run as a hidden helper
  that listens only on this PC (random port and secret) and exits with NovaDM.
  - Magnet links clicked in pages, pasted in the Downloads box or copied anywhere (clipboard
    watcher) open the New download dialog; `.torrent` links open in NovaDM instead of being saved
    (setting); "Open torrent" on the Downloads page opens .torrent files from disk.
  - **Choose the files**: a .torrent lists its files in the dialog; for a magnet link NovaDM first
    gets the torrent's details from other computers, then asks which files to download.
  - Status in the list: getting details, peers, speed, time left; after completion **seeding**
    with upload speed and ratio until the ratio or time limit (Settings → Torrents), or until you
    choose "Stop seeding". Properties show the info hash and the chosen files.
  - DHT, peer exchange and local peer discovery; an up-to-date public tracker list
    (github.com/ngosang/trackerslist), refreshed twice a day (can be turned off); upload limit.
  - aria2 is installed on demand (Settings → Torrents, about 2.5 MB from the official release over
    HTTPS), or NovaDM uses your own aria2c.exe. Without it, a torrent download says what to install.
- Torrent file reader (bencode): name, files, size and info hash shown before downloading; magnet
  links with hex or base32 hashes.

### Not verified here
- The real aria2 program was not run while testing (downloading it was not approved). The whole
  flow was tested in the app against a stand-in that answers like aria2's JSON-RPC.
- aria2 publishes no checksums, so its install is checked only by the HTTPS download from GitHub
  until a SHA-256 from a checked copy is pinned in `src/main/torrent/aria2.js`.

### Tests
- 89 unit tests (new: torrent files and magnet links, tracker lists, the aria2 RPC client and the
  torrent flow against a stand-in aria2: details → file choice → download → seeding → limit,
  cancel, errors, wrong secret).
- In-app self-test `tools/selftest-phase5.js`: magnet link clicked in a page → dialog → file
  chooser → download → seeding → Stop seeding; a .torrent link with one file unticked; the message
  without aria2. All earlier self-tests pass unchanged.

## [0.5.0] — 2026-10-09

Video capability (roadmap phase 4).

### Added
- **DASH streams (.mpd)** are detected, their qualities listed, and downloaded: SegmentTemplate
  ($Number$, $Time$, SegmentTimeline), SegmentList, SegmentBase (with the file's index) and
  single-file representations; several periods are joined. DRM-protected and live DASH are
  refused with a clear message.
- **Picture and sound joined without FFmpeg.** DASH video + audio, and HLS streams whose sound is a
  separate rendition (#EXT-X-MEDIA), become one normal MP4 with a video and an audio track. NovaDM's
  own MP4 merger renumbers the tracks, interleaves the fragments in time order, keeps audio and
  video on one timeline, and keeps the timeline going forward across periods/discontinuities. TS
  tracks are converted per track; AES-128 HLS segments are decrypted. Pause/resume continues byte
  for byte where it stopped, even after the manifest link expired; Refresh link reads the new
  manifest and keeps the progress when it lists the same segments.
- **Live stream recording** (HLS): recording starts near the live edge, the playlist is re-read
  and new segments are added until you press Stop (or the broadcast ends). The list shows
  "● Recording · 12:34 · size"; quitting or pausing finishes the file so it stays playable.
- **FFmpeg on demand** (Settings → Video tools): one click downloads the newest stable official
  Windows build (LGPL, about 80 MB, from github.com/BtbN/FFmpeg-Builds), checks it against its
  published SHA-256 and unpacks it; or point NovaDM to your own ffmpeg.exe. It is used only for:
  - joining picture and sound that come as WebM or plain MP4 files (saved as .mkv for WebM);
    without FFmpeg such a download stops right away and says what to install
  - "Save sound only (.m4a)", "Convert sound to MP3" and "Repair video" for finished downloads,
    each shown as its own entry with progress

### Tests
- 85 unit tests (new: MP4 merger incl. absolute offsets and DRM refusal, DASH parser for every
  segment layout, merged DASH and HLS downloads incl. a byte-identical resume, live recording and
  its end, FFmpeg build choice / verified install / WebM joining).
- In-app self-test `tools/selftest-phase4.js`: pages that load a DASH manifest and an HLS master
  with separate audio are detected, downloaded and then **played in Chromium with picture and
  sound**; a live stream is recorded and stopped; FFmpeg-less behaviour. All earlier self-tests
  pass unchanged.

### Not verified here
- The real FFmpeg download (about 80 MB) was not run while testing; the installer was tested with
  a local build archive and the official checksum list's format.

## [0.4.0] — 2026-10-09

Background downloading, scheduling and safety (roadmap phase 3).

### Added
- **Tray icon and background downloading.** Closing the window while downloads run keeps NovaDM in
  the system tray (tooltip shows count and speed; menu: open, pause all, resume all, quit).
  Settings → Background → "When the window is closed": keep downloading then quit (default),
  always stay in the tray, or quit.
- **Start NovaDM with Windows** (starts in the tray). For the portable build the portable .exe
  itself is registered.
- **Only one NovaDM at a time**: starting it again brings the running window forward.
- **Keep the computer awake while downloading** (on by default).
- **Queues and schedules** (Downloads → Queues): named queues, each with its own "at once" limit
  and an optional schedule (start time, optional end time, days of the week; overnight windows
  work). Inside the window the queue's downloads run, at the end they pause and wait
  ("Scheduled · starts …"), and the next window continues them. Start/stop a queue by hand,
  choose the queue in the New download dialog, or move a download with "Move to queue".
- **When all downloads finish** (Downloads page): close NovaDM, sleep or shut down, after a 60 s
  countdown with Cancel and "Do it now". It runs once, then goes back to "do nothing".
- **Microsoft Defender scan** of finished downloads (Settings → Safety: programs and archives by
  default, all files, or off). The result shows in the list; a threat is always notified.
- **Mark of the Web**: downloaded files are marked as coming from the internet (with the page and
  file address; private tabs record only "internet"), so SmartScreen checks programs and Office
  uses Protected View, as with browser downloads.

### Changed
- The download engine stays in NovaDM's main process instead of moving to a separate process as
  the roadmap suggested: downloads must share the browser session's cookies, Secure DNS and proxy,
  which only the main process has. Background downloading comes from the tray instead.

### Notes
- Defender's command-line scanner returns the same exit code for "threat found" and "scan
  failed", so NovaDM reads its report instead; a scan that can't run shows no result rather than
  a false alarm.

### Tests
- 66 unit tests (new: schedule windows incl. overnight and days, scheduler start/stop, Defender
  report parsing, Mark of the Web).
- In-app self-test `tools/selftest-phase3.js`: schedule window start/stop/continue, queue limit,
  Mark of the Web, scan results, countdown (dry run) and cancel, tray on close, keep-awake, second
  start. All earlier self-tests pass unchanged.

## [0.3.0] — 2026-10-09

The everyday basics of a download manager (roadmap phase 2).

### Added
- **Page downloads go to NovaDM.** Files a page starts (download links, buttons, "attachment"
  answers) used to go to Chromium's own downloader; now NovaDM's engine takes them over, with the
  page as Referer and the tab's cookies. Links that can't be fetched again (`blob:`/`data:` links,
  answers to form POSTs) are still saved by the browser, into NovaDM's folders, and shown in the
  list.
- **New download dialog**: file name, size (asked from the server when unknown), folder, speed
  limit for this download, optional checksum to verify, "Add paused", and a notice when the same
  link is already in the list (with "Resume that one"). "Don't ask again" turns it off; the
  setting is "Ask before each download".
- **Copied links**: when a link to a file type on your list is copied in any app, NovaDM asks
  whether to download it (Settings → Clipboard). NovaDM's own "Copy link" actions don't trigger it.
- **Several links at once**: the Downloads page box accepts many links and batch patterns
  (`img[001-120].jpg`, `part[a-f].zip`); a pick list shows them first.
- **Notifications** when a download finishes (click opens it; programs and archives open their
  folder) or fails (click opens the Downloads page).
- **Resume unfinished downloads when NovaDM starts** (Settings → Downloads).
- **Per-download speed limit**, in the dialog and in Properties (applies immediately).
- **Checksum check** after download (MD5, SHA-1, SHA-256 or SHA-512); a mismatch is shown in the
  list and in the notification.
- **Refresh link** for downloads whose link stopped working: open the download page and start the
  download (or play the video) again — NovaDM continues the old download from the new link — or
  paste a new link. The new link must be the same file (same size); progress is kept.
- **Proxy** (Settings → Proxy): Windows settings, no proxy, a manual HTTP/HTTPS/SOCKS4/SOCKS5
  server with exceptions, or a PAC script; sign-in with a user name and a password stored
  encrypted by Windows. Used by pages and downloads.
- Downloads from private tabs use the private session's cookies and aren't saved in the list.

### Fixed
- **With a speed limit, streamed videos (HLS) could lose the end of segments** (a damaged video),
  and HTTP downloads stalled for several seconds on each connection. The stream could report
  "finished" while NovaDM was still waiting on the limiter for the last chunk. Present since 0.1.0
  whenever a speed limit was set.
- A link that expired in the middle of a download was retried forever; it now stops with "The
  download link expired" and keeps the progress for Refresh link.
- NovaDM's own connections through a proxy could hang forever when the proxy refused to tunnel;
  they now time out and fall back to the browser's connections, and plain `http://` links behind a
  proxy always use the browser's connections.
- An error box ("Cannot read properties of null (reading 'contentView')") could appear when
  quitting with extensions installed.
- Downloads added paused showed as "Queued" forever.
- The clipboard is read correctly with Electron 44 (its clipboard API is now asynchronous).

### Tests
- 56 unit tests (new: links, patterns and checksum kinds; speed-limited HTTP and HLS; a link that
  expires mid-download; proxy fallback).
- In-app self-test `tools/selftest-phase2.js` for every feature above, against local servers
  (including a proxy with sign-in).

## [0.2.0] — 2026-10-09

Faster, crash-safe downloads (roadmap phase 1), and the rename to NovaDM.

### Changed
- **Renamed from "Swoop" to NovaDM.** The app name, installer and portable file names
  (`NovaDM-Setup-<version>.exe`, `NovaDM-Portable-<version>.exe`), app ID, internal page scheme
  (`novadm://`), launcher (`Start NovaDM.cmd`) and debug variables (`NOVADM_*`) all use the new name.
- Existing Swoop profiles (settings, downloads list, extensions, cookies) are moved from
  `%APPDATA%\Swoop` to `%APPDATA%\NovaDM` on first start. If the download folder was still the
  default `Downloads\Swoop`, it changes to `Downloads\NovaDM`; a folder you chose yourself is kept.
- The repository root is now the app folder (`NovaDM/`), with `docs/`, README and changelog inside.

### Added
- **New HTTP download engine** (ideas from Motrix/aria2, Gopeed, AB Download Manager and XDM):
  - the first response is used as connection #1 (no extra probe request; one-time links work)
  - slow start: connections are added while they still make the download faster, up to the limit
  - work stealing by time left, so slow parts get help near the end, without endless re-splitting
  - 1 MB write cache per connection, file preallocated, positional writes
  - crash-safe checkpoints: data is synced to disk every 30 s or 64 MB *before* progress is saved
  - resume sends `If-Range`, so a file that changed on the server starts over instead of being
    stitched together
  - 403 on an extra connection = server connection limit (holds there); 429/503 back off with
    `Retry-After`; an expired link is reported as such; free disk space is checked before starting
- **More than 6 connections per server.** Chromium allows only 6 per server on HTTP/1.1; NovaDM now
  opens the extra connections with its own HTTP client (undici). They use the browser's cookies,
  the page's Referer and headers, Secure DNS (through the browser session), the session's proxy and
  the Windows certificate store. If a server refuses them, NovaDM switches back to the browser's
  connections for that server automatically. Measured in the app: 40 MB from a throttled local
  server took 6.2 s with 16 connections vs 9.6 s with the browser's 6.
- Setting **Connection method**: Automatic (recommended) / Browser only / Always NovaDM's own.
- **HLS (streamed video) downloads**:
  - parallel segment fetches start at 3 and double while the speed still rises (up to the
    connection setting); 429/503 make them shrink and wait
  - crash-safe checkpoints every 10 s / 32 MB (synced to disk first)
  - AES-128 keys are saved with the progress and the playlist is kept next to the download, so a
    paused stream still resumes after its playlist or key link has expired
- Properties shows how many connections a running download uses (and how many are direct).
- Quitting NovaDM pauses running downloads properly (data written, synced, progress saved) and
  remembers them for the upcoming "resume on start" option.
- `npm test` (49 unit tests), an in-app self-test for the new engine (`tools/selftest-transport.js`),
  this changelog and the README.

### Fixed
- Downloads that were queued when NovaDM closed no longer stay "queued" forever after a restart.
- Downloads paused by 0.1.0 resume with the new engine instead of starting over.
- Pausing a download while it was still connecting could leave its file open.

## [0.1.0] — 2026-10-09 (released as "Swoop")

First packaged version: `Swoop-Setup-0.1.0.exe` and `Swoop-Portable-0.1.0.exe`.

### Browser
- Brave-style tabbed browser (Electron 44) with private tabs, a new tab page and settings
- Right-click menu with "Download link with NovaDM" and download image/video/audio
- Chrome Web Store: install extensions and use them from the toolbar
- Secure DNS (DNS over HTTPS) to get past ISP DNS blocking, with a choice of providers
- Per-site permissions (camera, microphone, location, notifications)
- Friendly error pages, including certificate errors

### Ad blocker and pop-up guard
- Ghostery engine with EasyList, EasyPrivacy, uBlock Origin lists and OISD Big; per-site off switch
- Pop-up guard that asks before a pop-up opens; ad pop-ups and ad redirects are blocked
  without asking; Ask / Block / Allow modes and an allow list

### Media and grabber
- Video/audio detection (HLS, MP4/WebM, subtitles) from network traffic and the page
- Download button on playing videos, media icon in the toolbar
- DRM-protected streams are detected and labelled (no decryption)
- Content grabber for images on a page, including lazy-loaded and CSS background images

### Downloads
- Multi-part HTTP downloads (up to 32 connections) with pause, resume and retries
- HLS downloads converted to MP4 segment by segment (flat memory use), with pause and resume
  that keep the video timeline continuous
- Downloads page in the style of 1DM with categories, search, bulk actions and Properties
  (links, path, size, speed, dates, parts, MD5 / SHA-256 checksums, "Download again")
- Speed limit, maximum active downloads, category folders, names from page titles
- Windows installer (NSIS) and portable build

[Unreleased]: ../../compare/v0.7.0...HEAD
[0.7.0]: ../../compare/v0.6.0...v0.7.0
[0.6.0]: ../../compare/v0.5.0...v0.6.0
[0.5.0]: ../../compare/v0.4.0...v0.5.0
[0.4.0]: ../../compare/v0.3.0...v0.4.0
[0.3.0]: ../../compare/v0.2.0...v0.3.0
[0.2.0]: ../../compare/v0.1.0...v0.2.0
[0.1.0]: ../../releases/tag/v0.1.0
