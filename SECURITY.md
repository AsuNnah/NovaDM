# Security policy

## Supported versions

Only the **latest release** gets security fixes. The installed version updates itself (Settings →
About shows the version and checks for updates); the portable version shows a notice when a new
version is out.

| Version | Supported |
|---|---|
| Latest release ([Releases](https://github.com/AsuNnah/NovaDM/releases/latest)) | Yes |
| Older versions | No — please update |

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately:

1. Go to [Security → Report a vulnerability](https://github.com/AsuNnah/NovaDM/security/advisories/new)
   (GitHub private vulnerability reporting).
2. Describe what an attacker can do, the NovaDM version, Windows version, and the steps or a
   proof of concept. A problem report from the app (menu → *Report a problem…*) helps; it has
   personal data removed, but read it before attaching.

What happens next:

- You get an answer as soon as possible; NovaDM is maintained by one person, so this can take a few
  days.
- Confirmed problems are fixed in a new release; the fix and its credit (if you want it) go in the
  release notes and the security advisory.
- Please give a reasonable time to release a fix before publishing details.
- There is no bug bounty.

## Scope

In scope: the NovaDM app (`src/`), its browser extension (`browser-extension/`), the update channel
(GitHub releases and `latest.yml`), and how NovaDM downloads and checks its add-ons.

Out of scope: problems in the add-ons themselves (yt-dlp, FFmpeg, aria2), in Electron / Chromium
(report those upstream; NovaDM ships their fixes in updates), in websites, and attacks that need
someone who already controls the PC.

How NovaDM is protected and tested: [docs/security.md](docs/security.md). How every change is
checked before release: [docs/pipeline.md](docs/pipeline.md).
