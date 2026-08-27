import { BaseSideService } from '@zeppos/zml/base-side'

// zml's BaseSideService transparently relays this.httpRequest() calls made
// from the device-app side over BLE, then performs the actual fetch here —
// this process runs inside the Zepp App on the phone, which has real
// network access, unlike the watch itself.

const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const AUDIO_NOTE_ENDPOINT = `${RELAY_BASE_URL}/api/watch/audio-note`
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '33d248e9de3f6cd180d35718ca7d8464145a5dc3368535cc'

AppSideService(
  BaseSideService({
    // PoC only (urs-zepp#4). zml wires @zos/ble file transfer, so a file
    // sent from the device with this.sendFile() surfaces here as
    // onReceivedFile. The exact payload shape (filePath vs. a readable
    // handle) needs confirming on-device — see the nightrun report.
    onReceivedFile(file) {
      if (!file || file.error) {
        this.log && this.log('audio-note transfer error', file && file.error)
        return
      }

      this.readTransferredFile(file)
        .then((bytes) =>
          fetch({
            url: AUDIO_NOTE_ENDPOINT,
            method: 'POST',
            headers: {
              'x-relay-token': RELAY_TOKEN,
              'content-type': 'application/octet-stream',
            },
            body: bytes,
          }),
        )
        .then((res) => {
          this.log && this.log('audio-note relay status', res && res.status)
        })
        .catch((e) => {
          this.log && this.log('audio-note relay failed', e && e.message)
        })
    },

    // The side service's file APIs differ from the device's @zos/fs. On a
    // real device, resolve `file` to an ArrayBuffer here (candidate paths:
    // a fetch of `file://<filePath>`, or the transfer lib's own read).
    readTransferredFile(file) {
      if (file && file.arrayBuffer) {
        return file.arrayBuffer()
      }
      return Promise.resolve(file && file.data)
    },
  }),
)
