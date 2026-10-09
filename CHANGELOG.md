# Changelog

All notable changes to NovaDM are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org/); each released version has a matching git tag
(`v0.1.0`, …), so you can go back to it with `git checkout v0.1.0`.

## [Unreleased] — will become 0.2.0

### Changed
- **Renamed from "Swoop" to NovaDM.** The app name, installer and portable file names
  (`NovaDM-Setup-<version>.exe`, `NovaDM-Portable-<version>.exe`), app ID, internal page scheme
  (`novadm://`), launcher (`Start NovaDM.cmd`) and debug variables (`NOVADM_*`) all use the new name.
- Existing Swoop profiles (settings, downloads list, extensions, cookies) are moved from
  `%APPDATA%\Swoop` to `%APPDATA%\NovaDM` on first start. If the download folder was still the
  default `Downloads\Swoop`, it changes to `Downloads\NovaDM`; a folder you chose yourself is kept.

### Added (in progress, not yet used by the app)
- **Download engine v2** (`src/main/download/http.js`), based on how Motrix/aria2, Gopeed,
  AB Download Manager and XDM download:
  - the first response is reused as connection #1 instead of being thrown away
  - slow start: connections are added while they make the download faster, up to the limit
  - work stealing by time left, so slow parts get help near the end
  - 1 MB write cache and crash-safe checkpoints (fdatasync every 30 s or 64 MB)
  - resume checks `If-Range` so a file changed on the server is not stitched together
  - handles 403 (too many connections), 429/503 with `Retry-After`, expired links, and checks
    free disk space before starting
- **Direct transport** (`src/main/transport.js`): an undici-based HTTP stack that is not limited
  to 6 connections per server, with the browser's cookies, Secure DNS, proxy and the Windows
  certificate store. It falls back to the browser's own network stack if a server refuses it.
- `npm test` runs the unit tests.
- Documentation: this changelog and the README.

### Known issues
- The engine v2 slow-start test still fails (it reaches 2 parallel connections on the test server
  instead of 4). The app keeps using the 0.1.0 engine until engine v2 is wired in and passes.

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

[Unreleased]: ../../compare/v0.1.0...HEAD
[0.1.0]: ../../releases/tag/v0.1.0
