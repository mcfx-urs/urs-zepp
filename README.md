# urs-zepp

A [Zepp OS](https://docs.zepp.com/) mini-app for Amazfit watches (built for
the Amazfit Active Max), companion to [urs-android](https://github.com/3lefeint/urs-android)
— quick logging actions from the wrist for the URS household-tracking app.

## Features

A two-level menu: the top-level `URS` screen lists the available counters,
and each opens a submenu of logging actions. The first counter, `Beer
Counter`, logs a beer to URS (`+330ml` / `+500ml`) without reaching for the
phone.

## Architecture

Zepp OS mini-apps run in two parts:

- **Device app** (`page/`, `app.js`) — runs on the watch itself, draws the
  UI.
- **Side service** (`app-side/`) — runs inside the Zepp App on the paired
  phone. It has real network access; the watch does not.

This app uses [`@zeppos/zml`](https://zepp-health.github.io/zml/) so the
device app can call `this.httpRequest(...)` directly — zml relays it over
BLE to the side service, which performs the actual fetch.

The side service calls a small local HTTP relay running inside
`urs-android` (loopback only, `http://127.0.0.1:8787`) rather than the
`urs-backend` API directly — the backend is only reachable through
`urs-android`'s own WireGuard tunnel and login session, neither of which
the watch or the Zepp App can use on their own. `urs-android` receives the
relayed request and makes the real, authenticated call to `urs-backend`.

### Which backend a tap reaches

The watch app only ever talks to `127.0.0.1:8787`. Which backend a beer
fill lands in depends entirely on which `urs-android` build is running the
relay on that port:

| `urs-android` build | Relay target |
| --- | --- |
| debug (`ch.mcfx.urs.debug`) | staging backend |
| release (`ch.mcfx.urs`) | production backend |

Only one build can hold port 8787 at a time. To log against production,
install the release build, turn on its **Watch Relay** setting, and make
sure the debug build's relay is off.

## Prerequisites

- [`@zeppos/zeus-cli`](https://docs.zepp.com/docs/guides/tools/cli/)
  installed **globally**: `npm install -g @zeppos/zeus-cli` (a
  project-local install breaks on its own bundled modules).
- `zeus login` once — needs a Zepp developer account. The session
  persists in `~/.zepp/`.
- `npm install` in this repo for the `@zeppos/zml` dependency.
- `app.json` already carries the registered `appId` and the Active Max
  device targets — nothing to fill in.

## Build & deploy

Three ways to get a build onto hardware, in order of everyday usefulness.

### 1. `zeus bridge` — push straight to the watch (primary)

No QR, no cable, no cloud round-trip. Needs Developer Mode in the Zepp app
on the paired phone:

1. Zepp app → **Profile → Settings → About** → tap the version row
   several times until Developer Mode unlocks, then enable it and turn on
   the CLI bridge connection.
2. From this repo:
   ```bash
   zeus bridge
   ```
   Then at the `bridge$` prompt:
   ```
   connect
   install -t "Amazfit Active Max"
   exit
   ```

The CLI reaches the phone over Zepp's dev server (both must be logged into
the same account); the phone does the Bluetooth push to the watch. Other
`bridge$` commands: `screenshot`, `uninstall`.

`ursctl` (in `../urs-ctl/`) has a **urs-zepp** submenu that runs
this flow via `expect`, falling back to printing the commands if `expect`
isn't installed.

### 2. `zeus preview` — cloud QR

```bash
zeus preview -t "Amazfit Active Max"
```

Builds, uploads to Zepp's cloud, and prints a QR code (valid 7 days). Scan
it in the Zepp app to install. No Developer Mode needed — use this to
install onto a phone that isn't set up for the bridge.

### 3. `zeus build` — production bundle

```bash
zeus build -t "Amazfit Active Max"
```

Writes a `.zab` to `dist/`, the artifact for uploading to the Mini
Program at [console.zepp.com](https://console.zepp.com/) (store submission
or private/trial distribution).

### Simulator

```bash
zeus dev -t "Amazfit Active Max"
```

Runs against the local Zepp OS simulator with live reload — not the real
watch.

## Releasing

SemVer. `master` is the release branch, `testing` is for ongoing work
(same split as `urs-android`).

1. Bump the version in **both** `app.json` (`app.version.name` and
   `app.version.code` — `code` is a monotonic integer) and `package.json`
   (`version`), kept identical.
2. From the first release onward, keep a `CHANGELOG.md` (Keep a Changelog
   format): move `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a
   fresh empty `## [Unreleased]` above it.
3. `zeus build -t "Amazfit Active Max"` as a sanity build.
4. Commit, fast-forward `testing` → `master`, tag `vX.Y.Z`, push.

`ursctl`'s urs-zepp submenu automates steps 1–4.
