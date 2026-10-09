# NovaDM 1.x plan — feature status, Brave-style speed, Tor private tabs

Research and plan written 2026-10-09.

Progress (see CHANGELOG.md):

| Version | Status |
|---|---|
| 1.0.0 | Done: history, bookmarks + bar + import/export, find in page, restore tabs, address-bar suggestions, third-party cookies blocked, clear on exit, UI size. The benchmark tool moved to 1.1 |
| 1.1.0 | Done: Shields rules (redirects, tracking codes, de-AMP, HTTPS upgrade), unloading tabs, reader view, benchmark (decision: keep Ghostery; element hiding is not a cost), live DASH recording (added on request) |
| 1.2.0 | Done: shortcuts + Tor-style hardening (see docs/v1.2-plan.md); Tor Browser private windows on hold |

## 1. Where the two earlier plans stand (after 0.8.0)

### docs/competitor-research-plan.md

| Item | Status |
|---|---|
| S1–S6 engine speed (direct transport, slow start, work stealing, first response reuse, write cache, HLS tuning) | Done 0.2.0 |
| T1–T3, T5, T6 stability (checkpoints, If-Range resume checks, error classes, saved HLS keys, free space) | Done 0.2.0 |
| T4 engine in a utilityProcess | Dropped (needs the browser session; tray covers background downloading) |
| A1 scheduler + queues, A4 tray, A10 after-download actions, A17 Mark of the Web, B7 Defender scan | Done 0.4.0 |
| A2 per-download limit, A3 proxy, A5 notifications, A6 clipboard, A7 batch/pattern, A8 refresh link, A9 checksum, A11 free space + duplicates, A16 skip dialog / auto-resume, B4 saved keys | Done 0.3.0 |
| B2 DASH + A/V merge, B3 FFmpeg on demand, B5 live HLS recording | Done 0.5.0 (live **DASH** not done) |
| B1 torrents via aria2 | Done 0.6.0 (real aria2 not yet run in tests) |
| A15 browser extension, B6 site extensions + yt-dlp, B9 API/CLI/links | Done 0.7.0 (Native Messaging replaced by the local API; extension not tried in a real Chrome) |
| A12, A13, A14, B8, B10, B11 | Done 0.8.0 |
| A18 theme / accent / page zoom | Done 0.8.0 |
| A18 auto-update | **Not done** (needs signed builds + public downloads) |
| A18 UI size for NovaDM's own screens, more languages | **Not done** |
| B12 ed2k, B13 mobile | Skipped by decision |

### 1DM feature list

| Area | Done | Not done |
|---|---|---|
| Download manager | 32 parts, dynamic splitting, queue/limits/auto-start/skip editor, restart-safe resume, retry/timeout, categories + folders, global and per-download speed limit, auto-rename, part files removed with the download, per-site connection limit, scheduler, checksum, proxy, DoH, custom user agent (per site), basic-auth sign-in per site | Cookie **import** from other browsers (only via cURL / extension), a "clean leftover part files" tool |
| Browser | Tabs, private tabs, zoom, right-click "Download with NovaDM", site permissions, ask before opening external apps | **History page, bookmarks, find in page (Ctrl+F), restore tabs on start** (setting exists, not wired), desktop/mobile UA toggle, reader mode, stop autoplay, block third-party cookies, clear cookies on exit |
| Pop-ups | Ask / Block / Allow, real clicks open without asking, per-site allow list | Overlay / JavaScript-link interception |
| Auto downloader | Media sniffer + badge, HLS (+AES), page-title names, clipboard, grabber (images), DASH + merge | Grabber recursion (crawl N levels), grabber for all file links (not only images), "page resources" view with the matching filter |
| Ad blocker | Lists + auto-update, per-site off, counters | Custom lists / hosts sources UI, allow-list manager page |
| Torrents | Magnet, .torrent, file choice, seeding limits | Upload speed limit in the UI (check) |

Biggest gaps for everyday browsing: **history, bookmarks, find in page, restore tabs**. These belong in 1.0 before anything else.

## 2. Brave: why it feels fast, and what NovaDM can copy

Brave renders with the same Blink + V8 as Chrome, and NovaDM (Electron 44) does too. Brave is not faster at
drawing pages. Its speed comes from **doing less work per page**:

| Brave technique | What it does | NovaDM today | Plan |
|---|---|---|---|
| **Shields / adblock-rust** (Rust, MPL-2.0; npm `adblock-rs`) | Blocks ads, trackers and third-party scripts before they load. 2025–26: filters moved to a zero-copy binary format, memory 162 → 104 MB | Ghostery engine (JS, also a serialized binary engine) | **Benchmark first.** Switch only if adblock-rs is clearly faster in Electron. It is a native addon, so it needs a Rust build per Electron version |
| **Cheap cosmetic filtering** | Brave found its injected cosmetic-filter JS was most of the ad-block cost; removing it cut that page-load time by ~81% | Preload reports DOM, main injects CSS/scriptlets | Profile it; inject generic hide-CSS once at document start, run procedural filters lazily/idle |
| **Debouncing** (public list of bounce-tracking URLs) | Skips tracker redirect hops and goes straight to the destination | None | Add, using Brave's open list (check its licence) |
| **Query-param stripping** | Removes `fbclid`, `gclid`, `utm_*` | None | Add (also helps caching) |
| **De-AMP** | Opens the publisher's real page instead of the AMP copy | None | Add |
| **HTTPS upgrade by default** | Skips the http → https redirect | Chromium default | Turn on Chromium's HTTPS-Upgrades / HTTPS-First feature |
| **Speedreader** | Reader view built from the page, no scripts | None | Reader mode with Mozilla Readability (Apache-2.0) |
| **Ephemeral third-party storage, farbling (fingerprint noise)** | Privacy, not speed | Partly (private tabs) | Reused in the Tor design below |
| Tab memory saving (Chromium Memory Saver) | Background tabs are discarded | Every tab keeps a live WebContents | **Tab discarding** (destroy background WebContentsView, keep URL/scroll, reload on select) + background throttling |

Expected order of gain: ad/script blocking and cosmetic cost > tab discarding > debounce/de-AMP/param stripping > engine swap.

**Measure before and after.** Add `tools/bench-pageload.js`, which loads a fixed list of sites three times each in a throwaway profile. It records load time, main-thread CPU and memory through the debugger API, and compares builds.

## 3. Tor private tabs

### What the research says
- **Brave's "Private Window with Tor"** runs the official **tor** executable as a separate process. Brave delivers and updates it as a signed component and keeps it updated (checked every 5 h). Private windows use it as a SOCKS proxy. Brave states plainly that these are "regular private windows that use Tor as a proxy" and **not** Tor Browser's protections. Bugs it had to fix:
  - `.onion` names were sent to normal DNS (fixed 2021)
  - `.onion` addresses leaked in Referer/Origin (CVE-2022-30334)
  - third parties did not get per-site circuits (fixed 2024, brave-browser#35464)
- **Tor Browser's design** needs much more than a proxy:
  - every request goes through Tor (proxy obedience)
  - no writes to disk
  - state isolated per first party, with **per-site circuits** via SOCKS username/password (`IsolateSOCKSAuth`)
  - fingerprinting defenses: letterboxing, bundled fonts, canvas permission, uniform UA, timezone UTC
  - a **security level** slider
  - **New Identity**
- **Tor Project downloads**: the **Tor Expert Bundle** for Windows contains tor.exe 0.4.9.x, the pluggable transports (bridges) and GeoIP files. It is signed with the Tor Browser Developers OpenPGP key.
- **Arti** (Tor in Rust) is moving fast. Its onion-service **client** shipped in 2023 without vanguards-lite, and I couldn't confirm it is now as secure as C tor. **Use C tor now; reconsider Arti later.**

### Honest limit
A Chromium-based browser can't look like Tor Browser (Firefox) to websites, so NovaDM's Tor tabs will be
**hidden IP + .onion access + strong leak protection**. They won't give Tor Browser-level anonymity. This is the same position Brave takes. The UI must say so
("For the strongest anonymity, use Tor Browser").

### Behaviour the user asked for
- Setting **"Private tabs use Tor"** (on by default once Tor is installed). Opening a private tab starts tor if needed and shows "Connecting to Tor… 45%". The tab won't load anything until Tor is connected.
- `.onion` addresses work **only** in Tor private tabs. In a normal tab, typing one offers "Open in a Tor private tab" and is **never** looked up through DNS.
- Purple tab/address-bar style, a Tor icon showing the circuit (countries of the 3 relays), "New circuit for this site" and "New identity".

### Architecture
```
Tor tab (in-memory session  tor-<tabId>)
   │ socks5 (Chromium sends host names; no local DNS)
   ▼
NovaDM SOCKS relay 127.0.0.1:<port per tab>   ← adds SOCKS user/pass = isolation key
   ▼
tor.exe  SocksPort 127.0.0.1:auto IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth
         ControlPort auto + CookieAuthentication; __OwningControllerProcess = NovaDM pid
```
Why the relay: Chromium can't send SOCKS credentials, so it can't ask tor for separate circuits by itself.
Each Tor tab gets its own in-memory session and relay port. The relay maps port → key, which gives separate
circuits and separate cookies per tab. That is stricter than Tor Browser's per-site circuits. Electron can't tell the relay which
first party a request belongs to, so true per-first-party isolation inside one tab is not possible. **Verify:** whether
Chromium in Electron 44 still ignores SOCKS credentials, and that `socks5://` resolves remotely (a leak test must prove it).

### Getting tor.exe (same rules as aria2/FFmpeg)
- Downloaded **only after the user agrees**, from `download.torproject.org`. NovaDM checks the `.asc` signature with
  openpgp.js against the pinned Tor Browser Developers key, and only then extracts it into `%APPDATA%\NovaDM\tor`.
  Or the user points NovaDM at their own tor.exe.
- Weekly update check, same verification. Tor's licence (BSD-3) allows shipping it.
- Bridges for censored networks: obfs4, Snowflake, WebTunnel (from the bundle). "Request bridges" is shown as a link to
  bridges.torproject.org; no automatic fetch.

### Strict security checklist (Tor tabs)
1. **Fail closed.** The Tor session proxy is fixed to the relay and never `direct`, with no fallback. If tor stops, pages fail; they never go out directly. Use `proxyBypassRules: '<-loopback>'` so pages can't reach localhost services.
2. **No DNS leaks.**
   - NovaDM's own fast transport (undici), Secure DNS, DNS prefetch and preconnect are off for Tor sessions.
   - `.onion` is blocked from every non-Tor path (normal tabs, the API, the clipboard watcher, the extension).
3. **No WebRTC/UDP leaks.** Set `webRTCIPHandlingPolicy: 'disable_non_proxied_udp'` and also block `RTCPeerConnection` in Tor tabs. QUIC can't go through SOCKS.
4. **No .onion leaks.** Strip Referer/Origin on onion → clearnet requests (Brave's CVE). Never write onion URLs to disk: no history, no Mark-of-the-Web HostUrl, no logs, no crash dumps with URLs.
5. **No disk state.**
   - In-memory partitions only; no session restore, thumbnails or download list entries for Tor tabs.
   - "New identity" closes all Tor tabs, wipes their sessions and sends `SIGNAL NEWNYM`.
6. **Downloads in Tor tabs** go through the Tor session only (Chromium `net`, one connection set per file).
   - Refused in Tor tabs: torrents/magnets (BitTorrent leaks IPs), yt-dlp, FFmpeg network use, site extensions, browser extensions, the local API.
   - Opening a downloaded file shows a warning that documents can contact the internet outside Tor.
7. **Clearnet over Tor:** HTTPS-Only (exit relays can read plain HTTP); `.onion` exempt. Offer the `Onion-Location` header's address.
8. **Permissions:** camera, mic, location, notifications, clipboard read, USB/serial/HID, screen capture all denied without asking.
9. **Fingerprint reduction** (not Tor Browser parity):
   - one fixed user agent and reduced client hints, `en-US` language, UTC timezone (debugger `Emulation.setTimezoneOverride`)
   - window letterboxing to 200×100 steps
   - canvas/WebGL/audio read-out blocked or noised
   - no system fonts list
10. **Security levels:**
    - *Standard*
    - *Safer*: no WebGL, no WebAssembly, no autoplay, remote fonts blocked, scripts off on plain-HTTP sites
    - *Safest*: JavaScript off everywhere
11. Ad blocker stays on.
12. Tor process: ports bound to 127.0.0.1 only, control cookie in the data dir, data dir in AppData, tor exits with NovaDM.

### Tests for Tor (before release)
- A local test server must see **zero** direct connections from Tor tabs (pages, downloads, WebRTC, prefetch).
- A fake DNS resolver must see zero lookups while Tor tabs browse.
- `.onion` in a normal tab must not produce a DNS query.
- With tor killed mid-page, nothing goes out directly.
- Two Tor tabs show different exit IPs (needs the real network; run only with the user's OK).
- No onion URL appears anywhere in `%APPDATA%\NovaDM` after a session.
- Compare against privacytests.org-style checks.

## 4. Release plan

| Version | Content |
|---|---|
| **1.0.0** | Daily-browser basics: history page, bookmarks + bar, find in page, restore tabs, block third-party cookies option, clear-on-exit; UI size setting |
| **1.1.0** | Speed: tab discarding + throttling, cosmetic-filter cost cut, debouncing, query-param stripping, de-AMP, HTTPS upgrade, reader mode; benchmark tool + adblock-rust vs Ghostery decision; **live DASH recording** |
| **1.2.0** | Tor private tabs: verified tor install, relay + per-tab circuits, fail-closed proxy, leak protections 1–8, `.onion` handling, Tor status/circuit UI, New identity, bridges |
| **1.3.0** | Tor hardening: fingerprint reduction, security levels, Onion-Location, leak test suite in CI-style self-tests |
| **1.4.0** | Leftovers: grabber for all links + crawl levels, page resources view, custom filter lists UI, cookie import, more languages |
| later | Auto-update (needs code signing + public releases); Arti instead of C tor once its onion client is on par |

## Sources
- Brave adblock engine: https://github.com/brave/adblock-rust
- Brave core: https://github.com/brave/brave-core
- Cosmetic-filter cost: https://www.ctrl.blog/entry/brave-ab-performance/
- adblock-rust memory 2026: https://www.theregister.com/2026/01/06/brave_refurbishes_rust_adblocking_engine/
- Debouncing: https://brave.com/privacy-updates/11-debouncing/
- Tor component updater: https://github.com/brave/brave-core/pull/316, https://github.com/brave/brave-browser/wiki/Component-Updater
- Brave Tor launcher: https://github.com/brave/brave-core/blob/master/components/services/tor/tor_launcher_impl.h
- Per-site circuits fixed: https://github.com/brave/brave-browser/issues/35464
- Onion leak CVE: https://cveawg.mitre.org/api/cve/CVE-2022-30334
- Tor Browser design: https://2019.www.torproject.org/projects/torbrowser/design/
- Stream isolation: https://www.whonix.org/wiki/Stream_Isolation
- Tor downloads / Expert Bundle: https://download.torproject.org/tor/
- Arti onion services: https://forum.torproject.org/t/arti-1-3-2-is-released-onion-services-rpc-relay-development-and-more/16728
