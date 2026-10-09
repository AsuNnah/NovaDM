# Changelog

All notable changes to NovaDM are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org/); each released version has a matching git tag
(`v0.1.0`, …), so you can go back to it with `git checkout v0.1.0`.

## [Unreleased]

Nothing yet.

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

[Unreleased]: ../../compare/v0.2.0...HEAD
[0.2.0]: ../../compare/v0.1.0...v0.2.0
[0.1.0]: ../../releases/tag/v0.1.0
