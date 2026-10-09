# NovaDM: your ideas vs. what's built, and what other browsers' and download managers' users ask for

Research 2026-10-09 (after 1.2.0). Sources at the end.

## 1. Your ideas: built or not

| Idea | Status |
|---|---|
| A Windows browser + download manager like 1DM | Done (0.1–0.8) |
| ~40 features from the competitor research (7 phases) | Done, except **auto-update** (needs signed builds) and **more languages** |
| Repo in `D:\Claude\Android to Windows\NovaDM`, private GitHub, version control, README + changelog per version | Done (tags v0.1.0 … v1.2.0) |
| Never upload private data | Followed (privacy scan before every push) |
| Brave-style speed | Done 1.1 (Shields rules, unload tabs, reader view, benchmark) |
| Live DASH recording | Done 1.1 |
| Everyday browser basics (history, bookmarks, find, restore tabs, cookies, UI size) | Done 1.0 |
| Brave shortcuts (Ctrl+F, Ctrl+Shift+I, …) | Done 1.2; Ctrl+Shift+J / C open DevTools but not straight to Console / inspect |
| Tor-style hardening for normal tabs, with measured cost | Done 1.2 (fingerprinting, WebRTC, Safer / Safest); **not possible in Electron**: Tor's font list, window-size steps, coarser timers; WebAssembly-only off not done |
| On/off per site in the shields panel | Done 1.2 |
| Tor in private browsing (Electron + tor.exe, then real Tor Browser windows with NovaDM look) | **On hold** (planned, size measured: +108 MB download, ≈+300 MB disk) |
| 1DM leftovers: grabber for all links + crawl levels, page resources view, custom filter / hosts lists, allow-list page, cookie import, desktop/mobile UA switch, overlay / JS-link pop-up interception | **Not done** (planned as 1.4) |

## 2. What other projects' users ask for most, and whether NovaDM has it

Download managers (GitHub issues sorted by reactions; 👍 = reactions) and IDM's feature list:

| Request | Who asks | NovaDM |
|---|---|---|
| Video/audio download, yt-dlp | AB DM (31👍, 13👍), Motrix (17👍, 7👍) | Have |
| Torrents | AB DM (20👍, 12👍) | Have |
| HLS/MPD from a pasted link | AB DM (6👍 ×2) | Have |
| Proxy, power options after download, auto-start, font size, custom categories, speed limit | AB DM, Gopeed (13👍) | Have |
| Edit a download's link and resume | XDM (12👍) | Have (Refresh link) |
| Custom user agent, command line, dark mode | XDM | Have |
| **Mega.nz / Google Drive / cloud-host links** | Motrix (8👍, 7👍) | **No** (only through a site extension) |
| **Modifier key to let the browser download instead (bypass)** | AB DM (8👍) | **No** in the browser extension (NovaDM's own Alt+click goes the other way) |
| **aria2-compatible RPC** (works with AriaNg and other remote apps) | Gopeed (10👍) | **No** (own API + MCP only) |
| **BitTorrent v2** | Motrix (5👍) | **No** (aria2 doesn't support it) |
| **RSS feeds that download new items** | Motrix (3👍) | **No** |
| **IDM-style "download complete" box** (Open / Open folder / Close) | Gopeed | Partly (Windows notification) |
| **FTP / FTPS / SFTP links** | Gopeed | **No** in the UI (aria2 could do FTP) |
| **Custom HTTP headers per site** | Gopeed | Partly (per-site user agent and sign-in) |
| **Subtitles downloaded with the video** | XDM | Partly (detected, separate download) |
| **Playlist downloads** (YouTube etc.) | XDM | **No** |
| **Accessibility** (screen reader, keyboard-only use) | XDM | **Not checked** |
| **Whole-site grabber / mirror** (IDM Site Grabber) | IDM | **No** (images and files of one page only) |
| **Sounds on start / finish / error** | IDM | **No** |
| Save file name with the time added | Motrix (8👍) | No (small) |
| Remote web UI with login | Gopeed | No |

Browsers (Brave community, Mozilla Connect top-voted, Vivaldi):

| Request | NovaDM |
|---|---|
| **Vertical tabs** | **No** |
| **Split view** (two pages side by side; Firefox 150 shipped "open in split tab") | **No** |
| **Tab groups** | **No** |
| **Profiles / workspaces** | **No** (one profile + private tabs) |
| **Sync** between PCs | **No** (export/import only) |
| **Speed dial / quick-access tiles** on the new tab | **No** (search box only) |
| **Customizable shortcuts** | **No** (fixed list) |
| **Mouse gestures** | **No** |
| **Picture-in-picture button**, several at once | **No** button (pages can still use it) |
| **Tab search** (Ctrl+Shift+A) | **No** |
| **Screenshot of a page** (visible / full page) | **No** |
| **Password manager / autofill** | **No** (Electron has no Chromium password manager) |
| **Translate pages** | **No** |
| Restore tabs, stay signed in, settings backup | Have |
| Memory saving | Have (unload tabs) |

## 3. Suggested next development

Ordered by value for effort. S = small (a day or less), M = a few days, L = a week or more.

| Version | Features | Size |
|---|---|---|
| **1.3 Download-manager wishes** | Bypass key in the browser extension (hold Alt to let the browser download); "Download complete" box (Open / Open folder); sounds on finish / error; date-time in file names (option); FTP links through aria2; custom headers per site; subtitles saved next to the video; playlist download through yt-dlp | S–M each |
| **1.4 Grabber and filters** (old 1.4 leftovers) | Grabber for all links + crawl N levels (IDM Site Grabber); page resources view; custom filter / hosts lists and allow-list page; cookie import from Chrome/Brave/Edge; desktop/mobile user-agent switch | M |
| **1.5 Tabs** | Tab search (Ctrl+Shift+A); vertical tabs; tab groups; split view; picture-in-picture button; page screenshot; speed-dial tiles | S (search, PiP, screenshot) to L (split view) |
| **1.6 Power users** | Customizable shortcuts; mouse gestures; aria2-compatible RPC (AriaNg works); RSS auto-downloads; profiles | M each |
| Later / needs a decision | Sync (needs a server or a sync folder); password manager (security-critical); translate (needs a service); cloud hosts (Mega / Google Drive, site rules change often); remote web UI; BitTorrent v2 (aria2 lacks it); auto-update (needs code signing); Tor Browser windows (on hold) | L |

## Sources
- Motrix issues: https://github.com/agalwood/Motrix/issues
- AB Download Manager issues: https://github.com/amir1376/ab-download-manager/issues
- Gopeed issues: https://github.com/GopeedLab/gopeed/issues
- XDM issues: https://github.com/subhra74/xdm/issues
- (GitHub search API, issues matching "feature", sorted by reactions, 2026-10-09)
- IDM grabber: https://mirror5.internetdownloadmanager.com/support/idm-grabber/index.html
- IDM features: https://www.videohelp.com/software/Internet Download Manager
- Brave desktop requests: https://community.brave.app/c/brave-feature-requests/desktop-requests/63
- Brave customization thread: https://community.brave.app/t/add-customization-to-brave-like-in-vivaldi/218026
- Mozilla Connect, April 2026 top ideas: https://connect.mozilla.org/t5/discussions/mozilla-connect-monthly-recap-top-voted-ideas-for-april-2026/m-p/124894
- Mozilla Connect, December 2025 top ideas: https://connect.mozilla.org/t5/discussions/mozilla-connect-monthly-recap-top-voted-ideas-for-december-2025/td-p/114952
- Vivaldi feature requests: https://forum.vivaldi.net/topic/17488/feature-requests-for-1-11/578
