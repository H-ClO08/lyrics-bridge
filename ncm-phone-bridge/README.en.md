# LyricsBridge · Phone edition (NcmPhoneBridge)

**English** | [简体中文](README.md)

Turn **whatever is playing on your Android phone** (title / artist / cover / progress) into a small
LAN service. Open it from a **tablet or desktop browser** and you get **live lyrics** — with
**no PC involved** and **no USB debugging**.

## What it solves

The old path: phone → (adb / wireless debugging) → PC (Node service) → tablet. It required developer
options and wireless debugging to stay on, and the permission surface was fairly broad.

This app moves "read playback state + serve a web page" entirely onto the phone:
**phone app → (HTTP) → tablet / PC**. adb is gone.

**Since v1.5, skipping tracks and liking songs on the tablet no longer needs a PC either.** The
control bar lives in the page served by the phone, and the NetEase account used for likes
(QR sign-in + weapi crypto) also runs on the phone. In other words: **a phone plus a tablet is all
you need.**

## How it works

```
Phone app (foreground service)
  ├─ Reads the active media session through "notification access"
  │     · title / artist / album / duration / position / cover bitmap
  ├─ Built-in HTTP server (default port 8787, hand-written, zero third-party dependencies)
  │     · /            lyrics page (large text + animations, customisable)
  │     · /api/state   playback state + matched LRC
  │     · /api/search  NetEase search (for fixing matches manually)
  │     · /api/cover   cover proxy (works around CORS)
  └─ Background thread: on track change, match lyrics by "title + artist + duration"
tablet / desktop browser ── HTTP ──▶ phone
```

## Install

1. Transfer the APK to your phone (WeChat / QQ / a cloud drive / a USB cable all work), then tap to install
   - On first install Android warns about "unknown sources" — allow it
2. Open the app

The current release is on the
[Releases page](https://github.com/H-ClO08/lyrics-bridge/releases), or build it yourself (see below).

## Usage (3 steps)

1. **Grant access** — tap "Grant notification access", find the app in system settings and enable it
   - Android requires this: without it, the app cannot see what is playing
2. **Start the service** — tap "Start service"; the app shows an address such as `http://192.168.1.23:8787`
3. **Open it on the tablet** — connect the tablet to the **same Wi-Fi** and open that address

From then on, whatever plays on the phone appears on the tablet: cover art, line-highlighted lyrics
and progress.

### Skipping and liking from the tablet (v1.5)

Below the cover and progress bar sits a translucent control bar: **previous · play/pause · next · heart**.
It stays dim and lights up for three seconds when touched, so it never competes with the lyrics.

- **Skip / play-pause** — commands go from the tablet back to the phone, where the app forwards them
  through the `MediaController` it obtained via notification access. No PC involved.
- **Like** — tap the heart, a QR code appears in the settings panel, confirm it with the **NetEase app
  on your phone**. The QR code is requested by the phone and the login state stays on the phone. It
  remains valid, so you don't need to rescan each time.
- The whole control bar can be disabled in settings ("Show control bar").

> Why likes require a login: they write account data, so an authenticated session is required.
> Lyrics, cover art and skipping do not.

> **You can also display it on a PC, two ways:**
>
> - **Push (new in v1.1, recommended)** — fill the PC's address into "Optional · push to PC" in the
>   app and the phone will push its state to the PC. On the PC, leave `phoneUrl` empty in
>   `config.json`, keep `source` as `auto`, and double-click `start.bat`. Both the web page and
>   BetterLyrics work, and **it doesn't matter if the phone's IP changes** — the phone is the
>   initiator, so it never needs to be discovered.
> - **Pull** — put the address shown by the app into `phoneUrl` in `config.json` and the PC pulls it.
>   The downside: you must update it whenever the phone's IP changes.
>
> See "The easiest setup: connect the phone app directly" in the desktop README.

## "This setting is currently unavailable for security reasons"

This is Android 13+'s **Restricted Settings** mechanism, **not a bug in the app**. The system blocks
apps installed from outside an app store from enabling high-privilege access such as accessibility or
notification access (a safeguard against fraud).

### Fix 1: allow restricted settings (recommended)

1. Try to enable notification access as usual and **let it fail once** — the system only reveals the
   option after you have attempted it
2. Go to **Settings → Apps → App management → LyricsBridge**
3. Tap **⋮** in the top-right corner (some ROMs label it "More", or place it at the bottom)
4. Choose "**Allow restricted settings**" (also seen as "Allow settings from this source" or
   "Lift restrictions")
5. Return and enable notification access — this time it works

Per-vendor differences:

- **vivo / iQOO** — Settings → More settings → Permission manager → find the app → "…" in the
  top-right → Allow restricted settings
- **Xiaomi / Redmi** — in addition to the above, enable "USB debugging (Security settings)" in
  developer options
- If you cannot find the entry, search for "**restricted**" or "**special access**" at the top of
  Settings; most ROMs jump straight to the right page

### Fix 2: grant it with a single adb command (if adb is still available)

```bash
adb shell cmd notification allow_listener com.ncm.phonebridge/com.ncm.phonebridge.MediaNotificationListener
```

After that you do not need to touch the system settings UI.

## Notes

- **Same LAN required** — same Wi-Fi, same router.
- **Display preferences are stored on the phone** (via `/api/prefs`), so changing the phone's IP or
  opening the page from another device keeps your font size, font family and layout. The settings
  panel also offers "Copy current settings / Paste to restore" for migrating between devices.
- The system may pause the service while the phone sleeps. Add the app to the **battery optimisation
  allowlist** so it keeps serving with the screen off.
- Lyric matching is a fuzzy search on "title + artist"; obscure covers are occasionally
  misidentified. Use "Title match" in the page settings to search for and pin the right track.
- **Obscure tracks showing "no timed lyrics"**: the NetEase lyric endpoint has two parameter sets.
  `lv=1` returns an empty string for some tracks (typically DJ edits, covers, unreleased tracks and
  live recordings), while `lv=-1` returns the timed original. Since v1.5.6 the app requests `lv=-1`
  first, falls back to `lv=1`, and then tries LRCLIB when NetEase has nothing. LRCLIB results are
  validated against title, artist and duration before use, so a same-name track cannot leak its
  lyrics in. If a track is still blank after upgrading, neither source has lyrics for it.
- Lyrics and covers come from NetEase **public endpoints** — unofficial usage. If those endpoints
  change, matching may stop temporarily (it degrades to showing the title only).

## API (for secondary development)

| Path | Description |
|---|---|
| `GET /` | Lyrics page (includes all display preferences) |
| `GET /api/state` | `{status, track, lyrics[], anchor}`; the front end polls once per second. Each `lyrics` item is `{t, x, r?, w?}`, where `w` holds the word-level timeline |
| `GET /api/nowplaying` | Condensed: `{title, artist, album, positionMs, durationMs, playing}` |
| `GET /api/search?q=` | NetEase search, returns `{songId, title, artist, album, duration}` |
| `POST /api/pin` | `{songId}` pin the song that corresponds to the current track |
| `POST /api/refresh` | Clear the match cache and match again |
| `GET /api/cover?url=` | Cover proxy (only NetEase image hosts are allowed) |
| `GET /api/art` | Cover bitmap of the current track (JPEG) |
| `GET /api/info` | Runtime status |
| `POST /api/control` | **v1.4**: `{"action":"next"\|"prev"\|"toggle"\|"play"\|"pause"}` — dispatches through the MediaController obtained via notification access (also accepts `?action=next`, convenient for curl) |
| `GET /api/account` | NetEase login state: `{loggedIn, nickname, likedKnown}`, **contains no credentials** |
| `POST /api/account/qr` | **v1.5**: request a login QR code, returns `{key, url}`; the page renders `url` as the QR image |
| `GET /api/account/qr?key=` | **v1.5**: poll the scan result — `800` expired / `801` waiting / `802` awaiting confirmation / `803` success |
| `POST /api/account/logout` | **v1.5**: sign out and delete the login state stored in the app |
| `POST /api/like` | **v1.5**: `{"songId":123,"liked":true}` add to or remove from "Liked songs" |

Every endpoint returns `Access-Control-Allow-Origin: *`, so any page on the LAN can call it directly.

> `/api/control` depends on notification access: without it there is no MediaController.
> Android does not report whether the player actually acted (`skipToNext()` returns void), so
> `ok:true` only means the command was dispatched. Error codes: `no-listener` / `no-session` /
> `no-manager` / `bad-action` / `exception`.
>
> `/api/account/*` and `/api/like` use NetEase's private web endpoints (weapi, AES + RSA). This is
> automation for personal use and may break when NetEase changes them — that only affects likes,
> never lyrics.

## Relationship to the desktop project

`ncm-nowplaying` (the desktop service) still works. With this app in place, the desktop service can
switch its data source from `adb` to `HTTP` (simply `GET` the phone's `/api/nowplaying`), so
**platform-tools and wireless debugging are no longer needed**.

## Technical notes

- **Zero third-party dependencies** — only the Android SDK and the Kotlin standard library; the HTTP
  server is hand-written on `ServerSocket`.
- **Authentication** — none. It listens on the LAN only, for a trusted home network. If you need to
  expose it publicly, put a reverse proxy and authentication in front.
- **Port** — `8787` by default (changeable via `BridgeService.PORT`).

## Building from source

Requires JDK 17 and the Android SDK (compileSdk 34 / build-tools 34.0.0). Gradle comes from the
bundled wrapper.

```bash
# point local.properties at your SDK (this file is not committed)
echo 'sdk.dir=/path/to/Android/sdk' > local.properties

./gradlew assembleDebug        # output: app/build/outputs/apk/debug/app-debug.apk
```

If downloading the Gradle distribution from `services.gradle.org` is slow, temporarily change
`distributionUrl` in `gradle/wrapper/gradle-wrapper.properties` to
`https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip`.
