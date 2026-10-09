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

### Ad blocker and pop-up guard
- Ghostery ad-block engine with EasyList, EasyPrivacy and uBlock Origin lists plus the OISD Big
  list, refreshed every 4 days
- Turn blocking off per site from the toolbar shield
- **Pop-up guard**: when a page tries to open a pop-up or a new window, NovaDM asks
  "Open this pop-up?" before anything happens. Pop-ups from known ad domains, and redirects of the
  current tab to ad sites, are blocked outright. You can choose Ask / Block / Allow and keep a list
  of sites that may always open pop-ups.

### Media detection and the content grabber
- Detects video and audio while a page plays: HLS (`.m3u8`), MP4/WebM files and subtitles, using
  network sniffing plus a page script that scans `<video>` elements
- A download button appears over playing videos and a media icon lights up in the toolbar
- HLS streams are saved as a single **MP4** (TS segments are converted on the fly, segment by
  segment, so memory use stays flat)
- **Content grabber**: lists every image on a page (including lazy-loaded and CSS background
  images) with sizes, filters and bulk download
- DRM-protected streams (Widevine) are detected and labelled; NovaDM does not decrypt DRM

### Download manager
- Multi-connection HTTP downloads (up to 32 parts) with pause, resume and retry
- HLS downloads with pause and resume (the MP4 timeline stays continuous across resumes)
- Downloads page in the style of 1DM: category tabs, search, bulk actions, progress, speed and
  time left, and a box to paste a link (file or `.m3u8` stream)
- **Properties** for each download: page and download links, mirrors, save path, resume support,
  size, average speed, dates, active time, parts, and MD5 / SHA-256 checksums; "Download again"
- Global speed limit, maximum active downloads, category folders, file names from page titles

## Running from source

Requirements: Windows 10/11 and [Node.js](https://nodejs.org/) 22 or newer.

```bash
cd novadm
npm install
npm start
```

After `npm install` you can also double-click `novadm/Start NovaDM.cmd`.

## Building the installer

```bash
cd novadm
npm run dist
```

This writes `NovaDM-Setup-<version>.exe` (installer) and `NovaDM-Portable-<version>.exe` to
`novadm/dist/`. The builds are not code-signed, so Windows SmartScreen may warn on first run.

## Tests

```bash
cd novadm
npm test
```

Unit tests cover the HLS parser, media classification, the media registry, TS→MP4 conversion, the
HTTP and HLS download engines (against a local test server) and the content grabber.

`novadm/tools/` holds in-app self-tests (`selftest-*.js`) and diagnostics. They run inside Electron
with a throwaway profile, for example:

```bat
cd novadm
set NOVADM_USERDATA=%TEMP%\novadm-test-profile
set NOVADM_SELFTEST=tools/selftest-popup.js
node_modules\electron\dist\electron.exe .
```

Other debug variables: `NOVADM_OPEN=<url>` opens a page at start-up instead of the new tab, and
`NOVADM_PANEL=<name>` opens a toolbar panel.

## Project layout

```
docs/                       design notes and the roadmap
novadm/
  src/main/                 Electron main process
    main.js                 window, views, layout, app start-up
    browser.js              tabs (one WebContentsView per tab)
    adblock.js, popup.js    ad blocker and pop-up guard
    dns.js                  Secure DNS
    extensions.js           Chrome extensions and Web Store
    grabber.js              content (image) grabber
    media/                  media detection, HLS parsing, TS→MP4
    download/               download manager, HTTP and HLS engines, speed limiter
    transport.js            direct HTTP transport for the new engine (in progress)
  src/ui/                   toolbar, panels, downloads, settings, new tab pages
  test/                     unit tests (node --test)
  tools/                    self-tests, diagnostics, icon generator
```

## Privacy

NovaDM has no telemetry and no accounts. Everything it stores (settings, the downloads list, tabs,
extensions, cookies) stays in `%APPDATA%\NovaDM` on your computer. The only network requests it makes
on its own are ad-block list updates and Secure DNS lookups to the provider you choose.

Profiles from the earlier name of this project ("Swoop") are moved to `%APPDATA%\NovaDM`
automatically on first start.

## License

No license has been chosen yet; all rights reserved. Note that NovaDM uses
[electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), which is
GPL-3.0, so any public release must be GPL-3.0 compatible.
