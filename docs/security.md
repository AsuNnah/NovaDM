# NovaDM security

This file lists what protects your sign-ins and data in NovaDM, what each protection does *not*
cover, and the test that checks it.

## Sign-ins and stored data

| Protection | What it does | Checked by |
|---|---|---|
| Encrypted cookies | Sign-in cookies (the thing that keeps you logged in) are encrypted on disk with a key protected by Windows (DPAPI), like Chrome. A copied profile folder or backup does not give away your sessions. | `tools/check-build-security.js`: a page sets a cookie, NovaDM closes, the cookie file is read directly. The secret is not in the file; 91 encrypted bytes are. Plain Electron (`--control`) stores the same cookie in plain text. |
| No saved site passwords | NovaDM has no password manager, so it never stores the passwords you type into sites. Use Bitwarden or KeePassXC (as an extension or app). | — |
| Encrypted NovaDM passwords | Proxy and site-login passwords that you give NovaDM (for downloads) are encrypted with Windows' data protection. | unit tests |
| Leaked-password warning | When you sign in, NovaDM checks the password against Have I Been Pwned's list of breached passwords. Only the first 5 characters of the password's SHA-1 hash leave your PC (k-anonymity); the reply is padded so its size gives nothing away; no cookies are sent; results are kept in memory only. Settings → Privacy → "Warn about leaked passwords" turns it off. | `test/hardening.test.js`; `tools/selftest-security.js` (warning shown, only the 5-character prefix sent, padding on, no cookie, no lookup when off) |
| Insecure sign-in warning | Warns when a password is sent over plain `http://` (except to your own PC). | `tools/selftest-security.js` |
| Deceptive-site warning | Page loads are checked on this PC against the Phishing URL Blocklist (OpenPhish, PhishTank; updated twice a day, downloaded daily) and uBlock's Badware risks list, whatever the Shields setting. A match shows a warning with *Go back* and *Continue anyway* (that site, until NovaDM closes). | `tools/selftest-v14.js` (warning, Go back to the real previous page, Continue anyway, setting off) |
| WebRTC through the proxy | While a proxy is in use (NovaDM's or Windows'), WebRTC may only use the proxy, so it can't reveal the real address. Without a proxy, local network addresses stay hidden. | `tools/selftest-v14.js` (policy with and without a proxy, also for new tabs) |
| Problem report without personal data | "Report a problem" saves a text file and opens it so you can read it first; nothing is sent. Web addresses keep only the site; user folders, file names, user and PC names, e-mail addresses and long tokens are replaced; settings that can hold personal data only say whether they are set. | `test/report.test.js`; `tools/selftest-v14.js` (an error containing your folder, user name, PC name and a login token comes out clean) |

## Tracking

Ad and tracker blocker, third-party cookies blocked, tracking redirects skipped, tracking codes
removed from addresses, HTTPS upgrade, fingerprinting protection, Tor Browser's security levels,
WebRTC limited to the public address, pop-up guard. Checked by `tools/selftest-popup.js`,
`selftest-v1.js`, `selftest-v12.js`, `selftest-speed.js` and the unit tests.

## The app itself

The installed `NovaDM.exe` is locked down with Electron fuses, so other programs on your PC can't
use it to run their code with NovaDM's name or read your sessions through it.

| Check (on the built app) | Result |
|---|---|
| Can not be used as a Node.js runner (`ELECTRON_RUN_AS_NODE`) | blocked |
| `NODE_OPTIONS` can not load code into it | blocked |
| No debugger port with `--inspect` | blocked |
| Test hooks (`NOVADM_SELFTEST`) only work when run from source | blocked |
| A changed `app.asar` does not start (integrity check) | refuses, exit code 1 |
| Cookies stored encrypted | yes |

Run them after `npm run dist`:

```bash
node tools/check-build-security.js
```

Fingerprinting protection and the leaked-password check also run in frames embedded from other sites (`tools/selftest-security.js`). Add-on downloads are verified: yt-dlp and FFmpeg against their published checksums, aria2 against a pinned SHA-256 (`test/addons.test.js`). Inside the app, the channel NovaDM's toolbar and panels use answers only NovaDM's own pages: a web page is refused even in a view that has the same preload (`tools/selftest-v14.js`).

## Limits (honest)

- Cookie encryption protects copied files and backups. Malware already running as your Windows
  user can ask Windows to decrypt them, as with any Chromium browser except Chrome's newest
  "app-bound" encryption, which Electron does not have. Device-bound sign-ins (DBSC) were tested
  and are not available in Electron 44. Planned: "forget sign-ins when NovaDM closes" for chosen
  sites.
- There is no Google Safe Browsing (Electron does not include it). The phishing lists above catch
  reported sites; a brand-new phishing page may not be on them yet.
- The toolbar view is not sandboxed yet (its extension buttons need a preload that can't run
  sandboxed); the menu, prompts and find bar are.
- The installer is not code-signed yet, so Windows SmartScreen may warn on first run.
