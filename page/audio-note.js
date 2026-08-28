import { createWidget, widget, align, prop } from '@zos/ui'
import { create, id, codec } from '@zos/media'
import { queryPermission, requestPermission } from '@zos/app'
import { setInterval, clearInterval, setTimeout, clearTimeout } from '@zos/timer'
import { statSync, readFileSync, readdirSync, rmSync } from '@zos/fs'
import TransferFile from '@zos/ble/TransferFile'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// The Recorder needs mic access. Declared in app.json, but it is a dynamic
// permission — the user still has to grant it at runtime the first time.
const MIC_PERMISSION = 'device:os.mic'
const PERMISSION_GRANTED = 2

// Record a note with @zos/media and get it to urs-android. The recording is
// also pushed to the phone once with @zos/ble file transfer (proves the
// Recorder → BLE → Zepp App link), but the delivery that actually persists
// it is a base64 upload over httpRequest to urs-android's loopback relay —
// the same relay path the beer action uses — because the Zepp companion
// service has no API to read a transferred file's bytes.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const AUDIO_NOTE_ENDPOINT = `${RELAY_BASE_URL}/api/watch/audio-note`
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '0'

// Provisional safety valve, not a recording-length limit: base64 rides zml's
// BLE messaging and a very large string risks the watch's JS heap. Raise or
// remove once longer recordings have been tested.
const MAX_UPLOAD_BYTES = 512 * 1024

// Upload retry: linear backoff, capped, for as long as the screen is open.
const RETRY_STEP_MS = 5000
const RETRY_MAX_MS = 60000

const BUTTON_IDLE = { normal_color: 0x1e88e5, press_color: 0x155fa0, text: 'Record' }
const BUTTON_REC = { normal_color: 0xe53935, press_color: 0xb71c1c, text: 'Stop' }

// After the STOP event the encoder may still be flushing — poll the file
// size and only act on it once it is non-zero.
const FILE_POLL_MS = 400
const FILE_POLL_MAX = 15
// The STOP event is not guaranteed to fire — poll anyway after this long.
const STOP_FALLBACK_MS = 1500

const NOTE_FILE = /^note-\d+\.opus$/

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

      // Pending uploads: { rel, uri, size, attempts }. In-memory only — a
      // note left unsent when the screen closes is picked up again by
      // scanLeftovers() next time it opens.
      this.queue = []
      this.uploading = false
      this.retryTimer = null
      this.blePushed = false

      createWidget(widget.TEXT, {
        x: 0,
        y: 50,
        w: DEVICE_WIDTH,
        h: 56,
        text: 'Audio note',
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

      this.scanLeftovers()
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
        this.enqueue({ rel: this.paths.rel, uri: this.paths.uri, size, fresh: true })
        this.pumpQueue()
        return
      }
      if (attempt >= FILE_POLL_MAX) {
        this.setStatus('No recording data')
        return
      }
      setTimeout(() => this.waitForFile(attempt + 1), FILE_POLL_MS)
    },

    // Re-enqueue any note file left on disk from a previous session that
    // never uploaded (screen closed, crash, relay unreachable).
    scanLeftovers() {
      try {
        const names = readdirSync({ path: '.' }) || []
        names
          .filter((n) => NOTE_FILE.test(n))
          .forEach((rel) => {
            const size = fileSize(rel)
            if (size > 0) {
              this.enqueue({ rel, uri: `data://${rel}`, size, fresh: false })
            }
          })
      } catch (e) {
        // no leftovers is the normal case
      }
      if (this.queue.length) {
        this.setStatus(`${this.queue.length} note(s) pending`)
        this.pumpQueue()
      }
    },

    enqueue(entry) {
      if (this.queue.some((e) => e.rel === entry.rel)) {
        return
      }
      entry.attempts = 0
      this.queue.push(entry)
    },

    dropEntry(entry) {
      this.queue = this.queue.filter((e) => e.rel !== entry.rel)
    },

    pending() {
      return this.queue.length ? ` (${this.queue.length} pending)` : ''
    },

    // One upload at a time; a concurrent BLE file transfer starves the zml
    // messaging handshake ("shake timeout"), so the BLE push waits too.
    pumpQueue() {
      if (this.uploading || this.queue.length === 0) {
        return
      }
      const entry = this.queue[0]

      if (entry.size > MAX_UPLOAD_BYTES) {
        this.dropEntry(entry)
        this.setStatus(`Note too long to upload — kept on watch${this.pending()}`)
        this.pumpQueue()
        return
      }

      let b64
      try {
        b64 = base64FromBytes(new Uint8Array(readFileSync({ path: entry.rel })))
      } catch (e) {
        // File vanished — nothing to send.
        this.dropEntry(entry)
        this.pumpQueue()
        return
      }

      this.uploading = true
      this.setStatus(`Uploading ${entry.size}B…${this.pending()}`)
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
          this.uploading = false
          // httpRequest resolves for any completed response, not just 2xx.
          if (res && res.status >= 200 && res.status < 300) {
            this.onUploaded(entry)
          } else {
            this.onUploadFailed(entry, `status ${res && res.status}`)
          }
        })
        .catch((e) => {
          this.uploading = false
          this.onUploadFailed(entry, (e && e.message) || `${e}`)
        })
    },

    onUploaded(entry) {
      try {
        rmSync({ path: entry.rel })
      } catch (e) {
        // best-effort — a stale file is picked up by scanLeftovers next time
      }
      this.dropEntry(entry)
      if (entry.fresh && !this.blePushed) {
        this.blePushed = true
        setTimeout(() => this.pushToPhone(entry.uri), 800)
      }
      this.setStatus(`Uploaded ✓${this.pending()}`)
      this.pumpQueue()
    },

    onUploadFailed(entry, reason) {
      entry.attempts = (entry.attempts || 0) + 1
      this.setStatus(`Upload failed (${reason}) — retry ${entry.attempts}${this.pending()}`)
      const delay = Math.min(RETRY_MAX_MS, RETRY_STEP_MS * entry.attempts)
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
      }
      this.retryTimer = setTimeout(() => this.pumpQueue(), delay)
    },

    // zml 0.0.43's this.sendFile() targets the old TransferFile shape
    // (instance.outbox.enqueueFile) and fails here, so drive
    // @zos/ble/TransferFile directly. Fire-and-forget, once per session.
    pushToPhone(uri) {
      try {
        new TransferFile().getOutbox().enqueueFile(uri, { type: 'opus' })
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
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
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
