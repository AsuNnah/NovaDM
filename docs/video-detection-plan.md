# NovaDM — Auto-detect & download (video first): research summary and Windows plan

## 1. What 1DM does (research summary)

See `1DM-feature-map.md` section 3 for the class-level findings. In short, 1DM:

1. Intercepts every WebView request and matches URLs against a list of media extensions.
2. Injects JavaScript into each page that hooks `XMLHttpRequest`, `fetch`, `window.open` and
   `WebSocket`, so it sees AJAX-loaded playlists, their response text and the exact request headers.
3. Scans the full page HTML with regexes, plus site extractors (Vimeo, Dailymotion, Facebook, ...).
4. Probes each candidate (`Range: bytes=0-`) and classifies it by Content-Type and the first bytes
   (`#EXTM3U`, `<MPD`, `WEBVTT`, `[Script Info]`).
5. Parses HLS/DASH: variants, resolution, bandwidth, duration, part count, AES-128 keys, live
   playlists, split audio/video, subtitles.
6. Downloads parts into temporary files, then merges them and converts TS to MP4/AAC with FFmpeg.

User-facing options found in the app: "Use webpage title as file name", "Convert ts files to mp4",
"Show video links which don't have audio", sort "Video first / Audio first / Both (prefer full
stream) / Full stream only", custom sniffer extensions and MIME types (with `!` to ignore),
automatic subtitle capture, built-in Preview/Stream, AES key viewer, "skip download editor when a
row is clicked", a per-site blacklist, and download buttons injected into social-media posts.

**DRM fallback:** 1DM's "DRM protected video handling" blocks the page's DRM (Widevine) request so
the site's player falls back to an unprotected stream, if the site has one. NovaDM gets this
behavior by default: Electron ships without Widevine, so DRM requests always fail and any
unprotected fallback the site serves is detected like normal media. NovaDM watches for the DRM
request and shows a note in the panel ("This site asked for DRM — showing the unprotected version
it provided"). Streams that are encrypted with DRM are labelled "Protected — can't download";
NovaDM does not decrypt them.

## 2. Where NovaDM can do better on Windows

| # | Improvement | How |
|---|---|---|
| 1 | Media identified by **real Content-Type and size**, not just URL extension | `webRequest.onResponseStarted` gives response headers for every request |
| 2 | **Downloads that behave exactly like the page** (no 403s) | `webRequest.onSendHeaders` records the request headers (Referer, Origin, Authorization, custom `X-` headers); the downloader replays them using the browser's own cookies and network stack |
| 3 | **No noise in the list**: stream fragments, ad videos, tiny files and duplicates are hidden | Skip `.ts/.m4s/seg_00001.mp4`-style fragments and anything referenced by a known playlist; skip responses under the minimum size; the ad blocker removes pre-roll ads |
| 4 | **Mirror grouping + multi-source download** | The same playlist path on two CDN hosts ((for example `cdn1.example-cdn.com` and `cdn2.example-cdn.com`)) becomes **one** entry; its segments are fetched from both hosts in parallel for more speed and failover |
| 5 | **Quality picker in one row** instead of one row per variant | Master playlist → dropdown: 1080p / 720p / 480p … with size estimate each |
| 6 | **"Playing now" first** | The video the page is actually playing is marked and pre-selected |
| 7 | **Download button on the video** (like IDM on Windows) | Small floating "Download" button appears when you hover a `<video>`; one click opens the panel on that video |
| 8 | **Thumbnails** | Poster image / `og:image` from the page shown next to each video |
| 9 | **Live stream recording** (1DM only flags live streams) | Live HLS → "Record" keeps fetching new parts until you press Stop |
| 10 | **No temp-file merge step** | HLS parts are downloaded in parallel and written in order straight into the final file; resume continues at the last written part |
| 11 | **TS → MP4 without FFmpeg** | mux.js converts on the fly while downloading |
| 12 | **Subtitles saved with the video** | Detected `.vtt/.srt` is offered as "save with video" using the same base name |
| 13 | **Blob downloads** handled natively | Chromium downloads `blob:` URLs itself; no base64 bridge |
| 14 | **Opt-in automatic download** | Per-site rule "Auto-download the main video on this site" (off by default) |
| 15 | **Better names** | `Page title [720p].mp4` instead of `seg_00000.mp4` |

## 3. Pipeline

```
 DETECT ─────────────► CLASSIFY ─────────► ANALYZE ─────────► GROUP ──────────► PRESENT ─────────► DOWNLOAD ─────► FINISH
 • network sniffer      • MIME / extension   • HLS master &     • de-duplicate     • toolbar badge     • HTTP multi-part  • TS→MP4 (mux.js)
   (headers + body       / first bytes         media playlist   • CDN mirrors      • Detected panel    • HLS engine:      • subtitles beside
   type)                 • drop fragments,     (variants, size,   → one entry      • on-video button     parallel parts,    video
 • DOM scanner            tiny files, ads      duration, keys,  • master+variants  • notifications       AES-128, mirrors • notify + library
 • page download events • DRM → "Protected"    live, audio)       → one row        • preview player   • replay captured  • (later) FFmpeg
 • clipboard watcher                         • probe direct     • mark "playing"                        headers            merge A+V
 • right-click menu                            files (size,                                           • live "Record"
                                               name)
```

Data model for a detected item:
`{ id, tabId, kind: file|hls|dash|subtitle, url, mirrors[], pageUrl, pageTitle, thumbnail,
mime, size | sizeEstimate, duration, resolution, variants[{label, url, bandwidth, resolution,
audioSeparate}], parts, encrypted: none|aes128|drm, live, playing, headers{...}, detectedAt }`

## 4. Build order

| Step | What | How it is checked |
|---|---|---|
| 1 | Network sniffer + classifier + grouping (main process) | Public HLS test streams and sample MP4s; noise-filter cases |
| 2 | HLS analyzer (master/media playlists, keys, live, audio groups, DRM detection) | Unit tests on sample playlists |
| 3 | Detected-media panel + toolbar badge (Brave-style UI) | Screenshots of the running app |
| 4 | HTTP multi-part engine + HLS engine with header replay and mirrors | Local test server with range support, throttling and dropped connections; public HLS (plain + AES-128) |
| 5 | Preview player (hls.js through an internal proxy that adds the captured headers) | Plays test streams |
| 6 | DOM scanner + on-video Download button | Pages with `<video>`, lazy players, iframes |
| 7 | TS → MP4 (mux.js), subtitles beside video | Output plays in VLC / Windows Media Player |
| 8 | Live recording, per-site auto-download rule | Public live test stream |
| 9 | Content grabber (images, documents, archives from the page) | Image gallery pages |
| later | FFmpeg (downloaded on first use, with your OK) for DASH and split audio + video merge; optional site extractors | — |

## 5. Limits (stated up front)

- DRM-protected streams (Widevine / PlayReady, `SAMPLE-AES`) cannot be downloaded and are labelled.
  Sites that only offer DRM video (Netflix, Disney+, Spotify) will not play in NovaDM at all, because
  Electron has no Widevine; use Chrome, Edge or Brave for those.
- Videos with separate audio (DASH, some HLS) need the later FFmpeg step; until then NovaDM picks a
  quality that has audio built in, or labels the item "No audio".
- Some sites' terms forbid downloading; NovaDM only saves what the page already streams to you.

## 6. UI direction (Brave-like)

- One compact top area: rounded tabs in the title bar, then a toolbar with Back / Forward / Reload, a
  wide rounded address bar, and on the right: **Shield** (blocked count, per-site on/off),
  **Media** (detected count badge), **Downloads** (progress ring), **Menu**.
- Panels open as popovers under their icon (like Brave Shields), not full-screen dialogs.
- New tab page: large search box, clock, stats (ads blocked, pop-ups blocked, data downloaded), top
  sites / bookmarks.
- Neutral dark and light themes, one accent color, 8 px radius, system font (Segoe UI Variable).
