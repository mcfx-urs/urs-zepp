import { createWidget, widget, align, prop } from '@zos/ui'
import { create, id, codec } from '@zos/media'
import { queryPermission, requestPermission } from '@zos/app'
import { setInterval, clearInterval, setTimeout, clearTimeout } from '@zos/timer'
import { statSync, readFileSync } from '@zos/fs'
import TransferFile from '@zos/ble/TransferFile'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// The Recorder needs mic access. Declared in app.json, but it is a dynamic
// permission — the user still has to grant it at runtime the first time.
const MIC_PERMISSION = 'device:os.mic'
const PERMISSION_GRANTED = 2

// PoC: record a short note with @zos/media and get it to urs-android. The
// recording is pushed to the phone with @zos/ble file transfer (proves
// Recorder → BLE → Zepp App), but the delivery that actually persists it
// is a base64 upload over httpRequest to urs-android's loopback relay —
// the same relay path the beer action uses — because the Zepp companion
// service has no API to read a transferred file's bytes.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const AUDIO_NOTE_ENDPOINT = `${RELAY_BASE_URL}/api/watch/audio-note`
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '33d248e9de3f6cd180d35718ca7d8464145a5dc3368535cc'

// Base64 inflates by ~4/3 and rides zml's BLE messaging — keep PoC notes short.
const MAX_UPLOAD_BYTES = 512 * 1024

const BUTTON_IDLE = { normal_color: 0x1e88e5, press_color: 0x155fa0, text: 'Record' }
const BUTTON_REC = { normal_color: 0xe53935, press_color: 0xb71c1c, text: 'Stop' }

// After the STOP event the encoder may still be flushing — poll the file
// size and only act on it once it is non-zero.
const FILE_POLL_MS = 400
const FILE_POLL_MAX = 15
// The STOP event is not guaranteed to fire — poll anyway after this long.
const STOP_FALLBACK_MS = 1500

// The recorder (target_file) and TransferFile (enqueueFile) take a data://
// URI; @zos/fs takes a path relative to /data. Derive both from one id and
// write to the data root — a data://download/ subdir is not created for us
// and the recorder then silently writes nothing.
function makePaths() {
  const rel = `note-${Date.now()}.opus`
  return { rel, uri: `data://${rel}` }
}

function fileSize(rel) {
  for (const p of [rel, `data://${rel}`]) {
    try {
      const st = statSync({ path: p })
      if (st && typeof st.size === 'number') {
        return st.size
      }
    } catch (e) {
      // try the next path form
    }
  }
  return -1
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64FromBytes(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

Page(
  BasePage({
    build() {
      this.recording = false
      this.elapsed = 0
      this.timer = null
      this.paths = null
      this.recorder = null
      this.stopFallbackTimer = null
      this.stopHandled = false

      createWidget(widget.TEXT, {
        x: 0,
        y: 50,
        w: DEVICE_WIDTH,
        h: 56,
        text: 'Audio note (PoC)',
        text_size: 32,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 120,
        w: DEVICE_WIDTH,
        h: 72,
        text: 'Idle',
        text_size: 24,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.elapsedWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 200,
        w: DEVICE_WIDTH,
        h: 32,
        text: '0s',
        text_size: 26,
        color: 0xffffff,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.button = createWidget(widget.BUTTON, {
        x: 90,
        y: 248,
        w: 300,
        h: 116,
        radius: 20,
        normal_color: BUTTON_IDLE.normal_color,
        press_color: BUTTON_IDLE.press_color,
        text: 'Record',
        text_size: 32,
        click_func: () => this.toggle(),
      })
    },

    toggle() {
      if (this.recording) {
        this.stopRecording()
      } else {
        this.startRecording()
      }
    },

    startRecording() {
      this.withMicPermission(() => this.beginRecording())
    },

    // device:os.mic is a dynamic permission: query it, and if it is not
    // already granted trigger the runtime consent prompt, then begin once
    // the callback reports it granted.
    withMicPermission(onGranted) {
      let granted = false
      try {
        granted = queryPermission({ permissions: [MIC_PERMISSION] })[0] === PERMISSION_GRANTED
      } catch (e) {
        // fall through to an explicit request
      }
      if (granted) {
        onGranted()
        return
      }

      this.setStatus('Requesting mic…')
      try {
        const rc = requestPermission({
          permissions: [MIC_PERMISSION],
          callback: (result) => {
            if (result && result[0] === PERMISSION_GRANTED) {
              onGranted()
            } else {
              this.setStatus('Mic permission denied')
            }
          },
        })
        if (rc === PERMISSION_GRANTED) {
          onGranted()
        } else if (rc === 1) {
          this.setStatus('Mic permission unavailable')
        }
      } catch (e) {
        this.setStatus(`Permission error: ${(e && e.message) || e}`)
      }
    },

    // @zos/media Recorder: create(id.RECORDER) → addEventListener(event.START
    // / event.STOP) → setFormat(codec.OPUS, { target_file }) → start() → stop().
    beginRecording() {
      this.paths = makePaths()
      this.stopHandled = false

      try {
        if (!this.recorder) {
          this.recorder = create(id.RECORDER)
          this.recorder.addEventListener(this.recorder.event.START, (ok) => {
            this.setStatus(ok ? 'Recording…' : 'Recorder did not start')
          })
          this.recorder.addEventListener(this.recorder.event.STOP, () => {
            this.onRecorderStopped()
          })
        }
        this.recorder.setFormat(codec.OPUS, { target_file: this.paths.uri })
        this.recorder.start()
      } catch (e) {
        this.setStatus(`Record failed: ${(e && e.message) || e}`)
        return
      }

      this.elapsed = 0
      this.elapsedWidget.text = '0s'
      this.setRecording(true)
      this.startTimer()
      this.setStatus('Recording…')
    },

    stopRecording() {
      this.stopTimer()
      this.setRecording(false)
      this.setStatus('Stopping…')
      this.stopFallbackTimer = setTimeout(() => this.onRecorderStopped(), STOP_FALLBACK_MS)
      try {
        this.recorder.stop()
      } catch (e) {
        this.setStatus(`Stop failed: ${(e && e.message) || e}`)
      }
    },

    onRecorderStopped() {
      if (this.stopHandled) {
        return
      }
      this.stopHandled = true
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer)
        this.stopFallbackTimer = null
      }
      this.waitForFile(1)
    },

    waitForFile(attempt) {
      const size = fileSize(this.paths.rel)
      if (size > 0) {
        // Upload first and alone — a concurrent BLE file transfer starves
        // the zml messaging handshake ("shake timeout").
        this.uploadToRelay(size)
        return
      }
      if (attempt >= FILE_POLL_MAX) {
        this.setStatus('No recording data')
        return
      }
      setTimeout(() => this.waitForFile(attempt + 1), FILE_POLL_MS)
    },

    // Read the .opus back, base64 it, POST over httpRequest — zml relays it
    // to the companion service, which fetch()es the loopback relay.
    uploadToRelay(size) {
      if (size > MAX_UPLOAD_BYTES) {
        this.setStatus(`Too large to upload (${size}B)`)
        return
      }
      let b64
      try {
        const buf = readFileSync({ path: this.paths.rel })
        b64 = base64FromBytes(new Uint8Array(buf))
      } catch (e) {
        this.setStatus(`Read failed: ${(e && e.message) || e}`)
        return
      }

      this.setStatus(`Uploading ${size}B…`)
      this.httpRequest({
        method: 'POST',
        url: AUDIO_NOTE_ENDPOINT,
        headers: {
          'x-relay-token': RELAY_TOKEN,
          'content-type': 'text/plain',
          'x-audio-encoding': 'base64',
        },
        body: b64,
      })
        .then((res) => {
          // httpRequest resolves for any completed response, not just 2xx.
          if (res && res.status >= 200 && res.status < 300) {
            this.setStatus(`Uploaded ✓ (${size}B)`)
          } else {
            this.setStatus(`Upload failed (${res && res.status})`)
          }
        })
        .catch((e) => {
          this.setStatus(`Upload failed: ${(e && e.message) || e}`)
        })
        .then(() => {
          // Link is free again — also push the file over BLE, the proven
          // Recorder → BLE → Zepp App path, kept for its own sake.
          setTimeout(() => this.pushToPhone(), 800)
        })
    },

    // zml 0.0.43's this.sendFile() targets the old TransferFile shape
    // (instance.outbox.enqueueFile) and fails here, so drive
    // @zos/ble/TransferFile directly. Fire-and-forget.
    pushToPhone() {
      try {
        new TransferFile().getOutbox().enqueueFile(this.paths.uri, { type: 'opus' })
      } catch (e) {
        // best-effort — the upload is the real delivery
      }
    },

    setRecording(on) {
      this.recording = on
      const style = on ? BUTTON_REC : BUTTON_IDLE
      this.button.setProperty(prop.MORE, style)
      // prop.MORE does not reliably update the label — set it explicitly.
      this.button.setProperty(prop.TEXT, style.text)
    },

    setStatus(text) {
      this.statusWidget.text = text
    },

    startTimer() {
      this.stopTimer()
      this.timer = setInterval(() => {
        this.elapsed += 1
        this.elapsedWidget.text = `${this.elapsed}s`
      }, 1000)
    },

    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },

    onDestroy() {
      this.stopTimer()
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer)
      }
      if (this.recorder && this.recording) {
        try {
          this.recorder.stop()
        } catch (e) {
          // best-effort
        }
      }
    },
  }),
)
