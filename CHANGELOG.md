# Changelog

All notable changes to NovaDM are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org/); each released version has a matching git tag
(`v0.1.0`, …), so you can go back to it with `git checkout v0.1.0`.

## [Unreleased]

Nothing yet.

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

[Unreleased]: ../../compare/v0.4.0...HEAD
[0.4.0]: ../../compare/v0.3.0...v0.4.0
[0.3.0]: ../../compare/v0.2.0...v0.3.0
[0.2.0]: ../../compare/v0.1.0...v0.2.0
[0.1.0]: ../../releases/tag/v0.1.0
