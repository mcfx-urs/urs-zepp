# urs-zepp

A [Zepp OS](https://docs.zepp.com/) mini-app for Amazfit watches (built for
the Amazfit Active Max), companion to [urs-android](https://github.com/3lefeint/urs-android)
— quick logging actions from the wrist for the URS household-tracking app.

## First feature

A single "+1 · 500ml" button that logs a beer to URS without reaching for
the phone.

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

## Setup

```bash
npm install
npx zeus login   # requires a Zepp developer account
npx zeus dev      # run in development mode
```

Requires the Zepp App (paired with an Amazfit Active Max, or the Zepp OS
simulator) for testing.

## Status

Early scaffold — not yet functional end to end. See `app.json`'s `targets`
block and `app.appId` before building for real: both are placeholders
pending a registered app ID and device-target confirmation via a real
`zeus login` session.
