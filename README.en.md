# LyricsBridge · 歌词桥

**English** | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%208.0%2B%20%7C%20Node%2018%2B-blue.svg)](#quick-start)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](CONTRIBUTING.md)

Turn whatever is playing in **NetEase Cloud Music on your Android phone** into
**live, line-synced lyrics on a tablet or in a desktop browser** — and control playback
from either screen. No PC in the middle, no USB debugging.

> Put on a song on your phone, read the lyrics and tap the heart on your tablet. Two devices, that's it.

> The per-component guides linked below are written in Chinese.

---

## What's in here

| Directory | What it is | What you need |
|---|---|---|
| [`ncm-phone-bridge/`](ncm-phone-bridge/) | **Android app.** Reads local playback state, serves its own HTTP API | An Android 8.0+ phone, install the APK |
| [`ncm-nowplaying/`](ncm-nowplaying/) | **Desktop service.** Node.js, three data sources, built-in browser view | Node.js 18+, zero dependencies |

They work standalone or together:

```
Phone (NetEase Cloud Music)
   │  notification listener → MediaSession
   ▼
LyricsBridge app ── HTTP :8787 ──▶ tablet / desktop browser
   │                                 lyrics + playback controls
   └──▶ NetEase endpoints (lyric matching / likes / QR login)
```

The phone app is the recommended path: no adb, no developer options, smallest permission surface.
The desktop service is for people already using adb, or who want a desktop lyrics app
such as BetterLyrics to take over rendering.

---

## Quick start

### Option 1: phone app only (recommended)

1. Download and install [`ncm-phone-bridge-v1.5.4.apk`](ncm-phone-bridge/ncm-phone-bridge-v1.5.4.apk)
2. Open the app and grant **notification access** (required to read playback state)
3. On your tablet or PC, open the address shown on the app's home screen, e.g. `http://192.168.1.23:8787`
4. To like tracks and skip from the tablet, scan the QR code in the app to sign in to NetEase

### Option 2: desktop service

```bash
cd ncm-nowplaying
node src/server.js                  # http://localhost:8787
node src/server.js --source=mock    # no phone needed, good for trying it out
```

The three data sources (adb polling, HTTP push, and masquerading as a Windows media session
for BetterLyrics) are documented in the [desktop guide](ncm-nowplaying/README.md).

---

## Features

- **Line-synced lyrics** — matched against NetEase by title + artist + duration, with cover art,
  progress and translations
- **Full control from the tablet** — previous / play-pause / next / like, all handled locally
  on the phone, never routed through a PC
- **Responsive layouts** — portrait, landscape and split-screen; controls stay centred with the
  cover art and the page never scrolls
- **Zero third-party dependencies** — the phone serves HTTP from a hand-written `ServerSocket`;
  the desktop service uses only Node's standard library
- **Adjustable UI** — font size, theme, blur, lyric offset; settings persist locally

---

## Permissions and privacy

| Permission | Why | Required |
|---|---|---|
| Notification access | Read the active media session (title / artist / progress / cover) | Yes |
| LAN access | Serve the lyrics page to your tablet | Yes |
| NetEase account (QR login) | Liking tracks and other authenticated calls | No, only for likes |

- The login cookie lives only in the phone's app-private storage and is **never** sent to the web page
- On the desktop side, credentials and lyric cache go to `.cache/`, which is git-ignored
- The lyrics page listens on the local network only and has no public tunnel; write endpoints are
  origin-checked

---

## Repository layout

```
.
├── ncm-phone-bridge/        # Android app
│   ├── app/src/main/java/com/ncm/phonebridge/
│   │   ├── BridgeService.kt        foreground service + media listener
│   │   ├── BridgeHttpServer.kt     hand-written HTTP server and routes
│   │   ├── NeteaseAccount.kt       QR login / likes
│   │   └── Weapi.java              NetEase weapi crypto (plain Java)
│   ├── app/src/main/assets/index.html   in-app lyrics page
│   └── ncm-phone-bridge-v1.5.4.apk      current release
└── ncm-nowplaying/          # Node.js desktop service
    ├── src/                 server, hub, lyric matching, source adapters
    ├── public/index.html    browser lyrics page
    ├── smtc/                Windows media session bridge (PowerShell)
    ├── tools/               self-check, latency measurement, security audit
    └── test/                test cases
```

Building from source:

```bash
cd ncm-phone-bridge
echo 'sdk.dir=/path/to/Android/sdk' > local.properties
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 17 and Android SDK 34. Gradle comes from the wrapper.

---

## Known limitations

- Only **NetEase Cloud Music** media sessions and lyric sources are supported; other players need
  a different matching path
- Phone and tablet must be on the **same LAN**; AP isolation on some routers will block the connection
- Notification access is restricted on some OEM ROMs and needs the "allow restricted settings" flow
- Lyric matching relies on NetEase search, so obscure tracks may not resolve — you can correct it
  from the page

## Contributing

Issues and PRs are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first (in Chinese).
For security issues, follow [SECURITY.md](SECURITY.md) and report privately instead of opening a
public issue.

## License

Code is released under the [MIT License](LICENSE), © 2026 H-ClO08. You may use, modify, sell and
redistribute it, including in closed-source products, as long as the copyright notice is kept.

**Lyrics, cover art and track metadata remain the property of their respective rights holders** and
are not covered by this license. This project is not affiliated with NetEase Cloud Music; it is a
personal LAN casting tool, so please don't use it to redistribute that content.
