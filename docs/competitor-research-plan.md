# NovaDM vs. Motrix, Gopeed, AB Download Manager, XDM — research and plan

Plan only, no code. Sources are listed at the end. Research date: 9 Oct 2026.

## 1. The four projects at a glance

| | Motrix | Gopeed | AB Download Manager | XDM |
|---|---|---|---|---|
| Status | Active, 2.0 beta (v2.0.0-beta.46, 2 Oct) | Active, 2.0 beta 3 | Active, v1.10.4 | Being rebuilt (2026) |
| UI | Electron + Vue | Flutter (native) | Kotlin, Compose Multiplatform | Swing (FlatLaf) |
| Download engine | **aria2** (separate process, JSON-RPC) | **Own Go engine** + anacrolix/torrent | **Own Kotlin engine** on OkHttp 5 | **Own Kotlin engine** (`xdm-core`) |
| Protocols | HTTP, FTP, BitTorrent, magnet | HTTP, BitTorrent, magnet, **ed2k** | HTTP(S) | HTTP(S), **HLS, DASH** |
| Video | FFmpeg add-on (2.0) | via JS extensions | browser-captured video, non-encrypted HLS | HLS + DASH grabber, **own MP4/MKV muxer** |
| Browser link | Native Messaging host, Safari ext | Browser extension | Extension + Native Messaging | Extension → local server `127.0.0.1:8597` |
| Platforms | Win/macOS/Linux, Docker | Win/macOS/Linux/Android/iOS/Web/Docker | Win/macOS/Linux/Android | Win/macOS/Linux |
| License | MIT | GPL-3.0 | Apache-2.0 | GPL-2.0 |

## 2. How each one downloads (engine design)

**Motrix (aria2).** Hands every task to an aria2c process over JSON-RPC. Settings seen: up to 10 tasks at once
and up to 64 connections per server (`ENGINE_MAX_CONNECTION_PER_SERVER = 64`; stock aria2 stops at 16, so this
needs a patched aria2 build), `min-split-size=1M`, `disk-cache=64M` (writes batched in memory),
`file-allocation=none`, infinite retries (`max-tries=0`, `retry-wait=10`), 10 s timeouts, session saved every
10 s. BitTorrent: DHT/DHT6, PEX, local peer discovery, 128 peers, head-first piece priority, tracker lists
auto-synced every 12 h from ngosang/XIU2, UPnP/NAT-PMP port mapping. 2.0 adds one-click FFmpeg (installed
separately, verified), shutdown after downloads, `motrix://` deep links, Native Messaging.

**Gopeed (Go).** Multi-connection HTTP with:
- *Slow start*: begins with 1 connection and grows in batches (1 → 2 → 4 → 16 …) up to the limit, only after
  connections succeed. A 403 on an extra connection is treated as "server connection limit": that connection
  stops, the others continue.
- *Work stealing* (`helpOtherConnection`): a finished connection helps the connection with the **longest
  estimated time left** (remaining bytes ÷ its speed, sampled every 500 ms), only if that is > 3 s and ≥ 512 KB
  remains; it takes the second half.
- *First response reused*: the first GET (no Range) keeps streaming as connection #1 while extra connections
  start, so one-time/signed links are never requested twice; data is prefetched to a temp file meanwhile.
- `If-Range` validator stored, so a file that changed on the server is detected on resume.
- Adaptive fast-fail timeout based on the measured connect time; retry delay min(retries+1 s, 5 s), 3 tries.
- File created at full size, written at offsets; server Last-Modified applied to the file.
- BitTorrent via anacrolix (DHT, uTP, PEX, WebTorrent peers, web seeds, seeding ratio/time limits), ed2k,
  **JavaScript extensions** (goja runtime, `onResolve` turns a page URL into files, settings + storage,
  installed from a git URL), REST API, webhooks, post-download scripts, MCP server, archive auto-extract.

**AB Download Manager (Kotlin/OkHttp).** Threads per download (default 8), global speed limiter, retry
(default 3), per-host settings (threads, User-Agent, credentials), queues with start times + scheduler,
categories with URL patterns, checksum verify, HTTP/system/PAC proxy, sparse files, keep-awake, shutdown when
done, Native Messaging browser link (can launch the app), REST API with API-key auth (Ktor), CLI, JSON
import/export, cURL import/export of credentials, OkHttp DNS-over-HTTPS available.

**XDM (Kotlin `xdm-core`).**
- One temp file written at offsets (no per-part files to merge).
- Starts as one chunk; splits the chunk with the most bytes left (≥ 256 KB), at most once per second; a
  chunk that just took over work is left alone for 5 s (prevents thrashing). Failed chunks are retried first.
- **Durability**: forces data to disk every 64 MB or 30 s *before* saving progress, so a crash or power cut
  never records progress the disk doesn't have. On restore it checks the temp file and the parts; if they
  don't add up it starts over instead of producing a corrupt file.
- `InvalidResponse` after data was received → "session expired" → **Refresh link** window.
- Per-task speed limiter.
- Streams: HLS (with **saved AES keys** so resume works after the key URL expires) and full **DASH** (MPD
  templates, periods, representations). **Pure-Kotlin transmuxer**: TS / fMP4 / WebM / packed audio in →
  MP4 or MKV out, **merges separate audio + video**, repairs discontinuous timelines; FFmpeg kept only as a
  retired fallback. Live-stream recording, antivirus scan after download, batch download, clipboard add.

## 3. Where NovaDM stands today (relevant parts)

- HTTP engine on Chromium's network stack (Electron `net`): same cookies, TLS, proxy and Secure DNS as the
  browser. **Limit: 6 connections per server on HTTP/1.1**, so 8–32 "connections" are capped at 6.
- Splits the part with the most *bytes* left (≥ 1 MB); probes with `Range: 0-0` and then opens a new request
  (one extra round trip; one-time links can break); each network chunk is written separately (many small
  writes); HTTP progress is saved only at start/pause/error (a crash re-downloads everything since start).
- HLS: parallel parts, AES-128, TS→MP4 (mux.js), mirrors, resume (progress saved every 5 parts, no fsync).
- Settings that exist but **do nothing yet**: clipboard watch, notify on complete, auto-resume on start,
  skip download dialog. No tray, no proxy settings, no scheduler, no torrents, no DASH, no A+V merge.

## 4. Missing features — Category A: Common (most download managers have these)

| # | Feature | Who has it | How in NovaDM (technology) | Size |
|---|---|---|---|---|
| A1 | **Scheduler + named queues** (start/stop time, days, per-queue limit) | AB DM, XDM | Queue model in `DownloadManager`; timer service in main; queue UI on Downloads page | M |
| A2 | **Per-download speed limit** (plus global) | XDM, aria2 | Second token bucket per task chained after the global `RateLimiter` | S |
| A3 | **Proxy** (HTTP/SOCKS/PAC/system) for browsing and downloads | all four | `session.setProxy()` (Chromium side); `undici` `ProxyAgent` for the direct engine (§6) | S |
| A4 | **Tray icon**, keep downloading when the window is closed, speed in tooltip | Motrix, AB DM | Electron `Tray`; engine moved to a `utilityProcess` (§6) | M |
| A5 | **Completion notifications** (setting exists, not wired) + sound | all | Electron `Notification`; click → open file/folder | S |
| A6 | **Clipboard watcher** (setting exists, not wired) + "add from clipboard", list of links | XDM, AB DM, 1DM | `clipboard.readText()` poll every 1 s; link list dialog | S |
| A7 | **Batch / pattern download** (`file[001-100].jpg`), import a text list | XDM, AB DM, Gopeed | Pattern expander + list dialog → `downloads.add` | S |
| A8 | **Auto-retry policy** + **Refresh link** for expired links | XDM, AB DM | On 403/410/expired: open the download page in a tab, the sniffer finds the new URL for the same file (size/name match) and swaps it in. **NovaDM can do this automatically because it is a browser** | M |
| A9 | **Checksum verify** against a given MD5/SHA-1/SHA-256 | AB DM | Field in Add / Properties; hash after finish | S |
| A10 | **After-download actions**: shutdown/sleep, keep PC awake, open file, run command | XDM, AB DM, Motrix 2.0, Gopeed | `powerSaveBlocker`; `shutdown /s /t 60` with cancellable countdown | S |
| A11 | **Free-space check**, duplicate detection | AB DM | `fs.statfs` before start; same URL/name prompt | S |
| A12 | **Per-site settings** (connections, User-Agent, login) | AB DM, Motrix (mock UA) | Host → settings map; Chromium `login` event + saved credentials for basic auth | M |
| A13 | **Categories with custom rules** (by URL pattern / extension) | AB DM | Rules table in Settings | S |
| A14 | **Import / export** downloads + settings; **paste a cURL command** to add a download with exact headers | AB DM | JSON files; cURL parser | S |
| A15 | **External browser integration** (send downloads/videos from Brave, Chrome, Edge to NovaDM) | all four | Small Chrome extension + Native Messaging host (NovaDM.exe registered as host, can launch NovaDM) — or local server on 127.0.0.1 like XDM | M |
| A16 | **Auto-start downloads / skip the dialog**, auto-resume on start (settings exist, not wired) | all | Wire existing settings; small "New download" dialog (name, folder, connections) | S |
| A17 | **Mark-of-the-Web** on downloaded files (Windows SmartScreen check for .exe etc.) | browsers | Write `Zone.Identifier` stream with the source URL | S |
| A18 | Auto-update, themes/accent colour, UI scale, more languages | AB DM, Gopeed | electron-updater (needs signed builds); CSS variables | M |

## 5. Missing features — Category B: Specific to one app

| # | Feature (from) | Worth it for NovaDM? | How (technology) | Size |
|---|---|---|---|---|
| B1 | **BitTorrent + magnet**: selective files, seeding limits, DHT/PEX, UPnP, **tracker lists auto-updated** (Motrix, Gopeed) | Yes | **aria2c as a separate process** controlled by JSON-RPC (Motrix's proven pattern, ~5 MB, GPL-2 binary shipped alongside). Alternative: WebTorrent (pure JS, slower, heavier) | L |
| B2 | **DASH + merge separate audio and video without FFmpeg**, timeline repair (XDM) | Yes — the biggest video gap | Pure-JS fMP4/CMAF muxer: one `moov` with two tracks, interleaved `moof/mdat` (XDM approach). MKV writer for WebM/VP9/Opus | L |
| B3 | **One-click FFmpeg**, installed separately and verified (Motrix 2.0) | Yes, optional | Download on first need (with OK), checksum-verified; used for edge cases, MP3 extraction, repair | M |
| B4 | **Saved HLS keys** so resume works after the key link expires (XDM) | Yes | Store AES keys in the `.part.meta` file | S |
| B5 | **Live stream recording** (XDM) | Yes | HLS engine polls the live playlist, appends new parts until Stop | M |
| B6 | **Site extensions** — JS that turns a page into files, installed from a git URL, with settings/storage (Gopeed) | Yes | Run in a sandbox (QuickJS-wasm or a sandboxed hidden renderer), `onResolve` + `fetch` only. Optional **yt-dlp** add-on for 1,000+ sites (site terms apply) | L |
| B7 | **Antivirus scan** after download (XDM) | Yes, cheap | Windows Defender `MpCmdRun.exe -Scan -ScanType 3 -File` | S |
| B8 | **Archive auto-extract** (Gopeed) | Maybe | 7-Zip binary (7zip-bin) or JS unzip for .zip | M |
| B9 | **REST API + CLI + deep links** (`novadm://`) (Gopeed, AB DM, Motrix 2.0) | Maybe | Local server with API key; `app.setAsDefaultProtocolClient('novadm')` | M |
| B10 | **Webhooks / post-download scripts** (Gopeed) | Later | Run command / POST JSON on finish | S |
| B11 | **MCP server** so AI agents can control downloads (Gopeed) | Later | MCP SDK over local HTTP | M |
| B12 | **ed2k** (Gopeed) | No (niche) | — | — |
| B13 | Mobile apps (Gopeed, AB DM) | Out of scope (Windows app) | — | — |

## 6. Download engine plan — speed, stability, capability

### Speed

| # | Change | Taken from | Why it helps | Size |
|---|---|---|---|---|
| S1 | **Direct transport** (`undici`, Node's own HTTP client) next to Chromium `net`. NovaDM picks per server: Chromium for HTTP/2 or protected sites; direct when the server is HTTP/1.1 and more than 6 connections are wanted. Keeps NovaDM's strengths: cookies copied from the browser session, page headers + Referer replayed, **Secure DNS via `session.resolveHost()`** fed into undici's `connect.lookup`, system/custom proxy via `ProxyAgent`. Falls back to Chromium on 403/TLS refusal | aria2, OkHttp, Go engines (none have the 6-per-host cap) | Removes the 6-connection cap: 16–32 real connections like IDM/Motrix | M |
| S2 | **Slow-start connections**: start at 1, grow 2 → 4 → 8 → 16 while total speed still rises; stop growing on 403/429/503 and honour `Retry-After` | Gopeed | Finds the best count per server automatically; avoids bans and wasted connections | M |
| S3 | **Steal by time left, not bytes left**, with a 5 s cooldown and 512 KB minimum | Gopeed + XDM | Slow connections near the end get help; no endless re-splitting | S |
| S4 | **Reuse the first response** as connection #1 instead of probing with `Range: 0-0` first | Gopeed | Saves a round trip per download; signed one-time links work | S |
| S5 | **Write cache**: collect 1–4 MB per connection before writing (aria2 `disk-cache=64M`) | Motrix/aria2 | Far fewer disk writes; matters at 50+ MB/s and on HDDs | S |
| S6 | **HLS concurrency auto-tuning** (more parts in flight while speed rises) + mirror rotation (exists) | Gopeed idea | Faster long videos on CDNs that allow it | S |

### Stability

| # | Change | Taken from | Why | Size |
|---|---|---|---|---|
| T1 | **Checkpoint every 30 s / 64 MB**: flush data to disk (`fdatasync`) *then* save progress, for HTTP and HLS | XDM | A crash or power cut resumes from the last checkpoint instead of restarting; never records data that isn't on disk | S |
| T2 | **Validate on resume**: part file size, parts cover the file, server `ETag`/`Last-Modified` via `If-Range` — start over if the file changed | XDM, Gopeed | No silently corrupt files after a resume | S |
| T3 | **Error classes**: 403 on extra connections = connection limit (drop that connection, keep others); 429/503 = back off with `Retry-After`; 403/410 after data = expired link → Refresh-link flow (A8); adaptive timeouts from measured connect time | Gopeed, XDM | Fewer failed downloads on strict servers | M |
| T4 | **Engine in an Electron `utilityProcess`** (separate process, talks to the UI over a message port) | Motrix (aria2 runs separately) | UI freezes or a page crash can't stop downloads; downloads keep running in the tray with the window closed | M |
| T5 | **HLS keys saved** in progress file (B4) | XDM | Resume after the key URL expires | S |
| T6 | **Free-space check + sparse file allocation** | AB DM, aria2 | Clear error before starting instead of a failed write at 99% | S |

### Capability

C1 BitTorrent/magnet via aria2 (B1). C2 DASH + A/V merge muxer (B2). C3 optional FFmpeg (B3). C4 live
recording (B5). C5 site extensions / optional yt-dlp (B6). C6 FTP/SFTP for free through aria2. C7 external
browser integration (A15). C8 REST API / deep links (B9).

## 7. Technology choices (recommendation)

| Area | Recommended | Alternatives considered | Reason |
|---|---|---|---|
| HTTP transport | **Hybrid: Chromium `net` + `undici` direct mode** | Only Chromium (6-cap stays); only Node http (loses browser TLS fingerprint → some Cloudflare-protected CDNs refuse) | Speed of a real download manager, with automatic fallback to browser-identical requests |
| Engine process | **Electron `utilityProcess`** | Keep in main process | Isolation + tray mode |
| Torrents | **aria2c sidecar** (JSON-RPC), patched build for >16 connections not needed (only BT/FTP use it) | WebTorrent (pure JS, slower); Gopeed's Go engine (duplicates our HTTP engine) | Mature, tiny, proven by Motrix |
| DASH / audio+video merge | **Own JS fMP4 muxer** (+ MKV writer later) | FFmpeg only (80 MB, must be downloaded) | XDM shows it works without FFmpeg; fast, no re-encode |
| Conversions / repair | **FFmpeg on demand** (verified download) | Bundle FFmpeg | Keeps the installer small (Motrix 2.0 approach) |
| Site extractors | **JS extensions in a sandbox** (Gopeed-style `onResolve`), optional yt-dlp add-on | Hard-coded site support | Extendable without updating NovaDM |
| Browser integration | **Chrome extension + Native Messaging** | Local HTTP server (XDM) | Can start NovaDM when it isn't running; no open port |
| Automation | Local REST API with API key, `novadm://` deep links | — | Same as AB DM / Motrix |

Licences: aria2 GPL-2 and FFmpeg GPL/LGPL are separate programs (fine to ship alongside or download);
undici MIT; NovaDM already uses GPL-3 for extension support.

## 8. Suggested order

Progress (see CHANGELOG.md for details):

| Phase | Status |
|---|---|
| 1. Engine speed + stability | Done in 0.2.0 (S1–S6, T1–T3, T5, T6) |
| 2. Half-done basics | Done in 0.3.0 (A2, A3, A5, A6, A7, A8, A9, A11, A16, B4) + page downloads go to NovaDM |
| 3. Background + scheduling | Done in 0.4.0 (A1, A4, A10, A17, B7). T4 (engine in a utilityProcess) dropped: downloads need the browser session's cookies, Secure DNS and proxy, which only the main process has; the tray gives background downloading instead |
| 4. Video capability | Done in 0.5.0 (B2 DASH + A/V merge without FFmpeg, also for HLS alternate audio; B5 live HLS recording; B3 FFmpeg on demand). Live DASH not yet |
| 5–7 | Not started |

1. **Engine speed + stability** (S1–S5, T1–T3, T6) — biggest benefit for what you download most.
2. **Wire the half-done basics** (A5, A6, A16) + per-download limit, proxy, free-space, duplicates (A2, A3, A11)
   + Refresh link (A8) + saved HLS keys (B4).
3. **Background + scheduling**: utilityProcess + tray (T4, A4), scheduler/queues (A1), after-download actions
   (A10), antivirus scan (B7), Mark-of-the-Web (A17).
4. **Video capability**: DASH + A/V merge muxer (B2), live recording (B5), FFmpeg on demand (B3).
5. **Torrents** via aria2 (B1).
6. **Integration**: Brave/Chrome extension (A15), REST API/deep links (B9), site extensions (B6).
7. Extras: import/export + cURL (A14), per-site settings (A12), categories rules (A13), archive extract (B8),
   webhooks/MCP (B10, B11), auto-update (A18, needs code signing).

## Sources

- Motrix: README, `src/shared/constants.js`, bundled `aria2.conf`, release v2.0.0-beta.46 — https://github.com/agalwood/Motrix
- aria2 connection limit (16) and patched forks: https://github.com/elypha/aria2-mod ,
  https://build.opensuse.org/package/show/home:calad/aria2-fast
- Gopeed: README, docs (https://gopeed.com/docs/ , https://gopeed.com/docs/dev-extension), `go.mod`,
  `internal/protocol/http/fetcher.go` — https://github.com/GopeedLab/gopeed
- AB Download Manager: README, CHANGELOG, `gradle/libs.versions.toml` — https://github.com/amir1376/ab-download-manager
- XDM: README, `xdm-core` sources (`HttpDownloader.kt`, `TransmuxingMuxer.kt`, file tree) — https://github.com/subhra74/xdm
