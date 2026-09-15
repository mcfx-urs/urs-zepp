import { createWidget, widget, align, prop } from '@zos/ui'
import { setTimeout, clearTimeout } from '@zos/timer'
import { readdirSync, readFileSync, statSync, rmSync } from '@zos/fs'
import * as display from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'
import { RELAY_TOKEN } from '../utils/relay-token'

const DEVICE_WIDTH = 480

// Same loopback relay the beer/chore actions use — the Zepp App side
// service does the real fetch, so 127.0.0.1 reaches urs-android without the
// backend tunnel.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const CHUNK_ENDPOINT = `${RELAY_BASE_URL}/api/watch/audio-note-chunk`

const NOTE_FILE = /^note-(\d+)\.opus$/

// zml BLE messaging (~5 KB/s measured) aborts a body mid-stream ("send
// message error") beyond roughly 40 KB base64. 24 KB raw per chunk
// (~32 KB base64) stays inside the range that transfers reliably, so every
// note — regardless of length — goes out as one or more chunks to the
// relay's reassembly endpoint. No per-note length limit; this sanity cap
// only guards against a runaway recording.
const CHUNK_RAW_BYTES = 24 * 1024
const SANE_MAX_BYTES = 2 * 1024 * 1024

// Backstop for an upload whose httpRequest never settles.
const UPLOAD_WATCHDOG_MS = 90000

// Keep the screen awake for the whole upload run: a display timeout
// suspends the page and drops the BLE link mid-transfer.
const SCREEN_HOLD_MS = 10 * 60 * 1000

// Encode this many input bytes per tick, yielding between slices so a large
// note never blocks the UI. Multiple of 3 to keep base64 groups aligned.
const B64_SLICE_BYTES = 6144
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64FromBytes(bytes, onDone) {
  const parts = []
  let i = 0
  const step = () => {
    const end = Math.min(bytes.length, i + B64_SLICE_BYTES)
    const buf = []
    for (; i < end; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
      buf.push(B64[b0 >> 2])
      buf.push(B64[((b0 & 3) << 4) | (b1 >> 4)])
      buf.push(i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=')
      buf.push(i + 2 < bytes.length ? B64[b2 & 63] : '=')
    }
    parts.push(buf.join(''))
    if (i < bytes.length) {
      setTimeout(step, 0)
    } else {
      onDone(parts.join(''))
    }
  }
  step()
}

function listNotes() {
  let names = []
  try {
    names = readdirSync({ path: '.' }) || []
  } catch (e) {
    return []
  }
  return names
    .map((rel) => ({ rel, match: NOTE_FILE.exec(rel) }))
    .filter((f) => f.match)
    .map(({ rel, match }) => {
      let size = -1
      try {
        const st = statSync({ path: rel })
        if (st && typeof st.size === 'number') {
          size = st.size
        }
      } catch (e) {
        // skip unreadable
      }
      // The filename's timestamp is set at recording start (page/audio-note.js
      // makePaths()) — the recording's actual start time, not upload time.
      return { rel, size, recordedAtMillis: match[1] }
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

function totalBytes(notes) {
  let sum = 0
  for (const n of notes) {
    sum += n.size
  }
  return sum
}

Page(
  BasePage({
    build() {
      this.notes = []
      this.busy = false
      this.destroyed = false
      this.brightHeld = false
      this.watchdog = null
      this.confirmDelete = false
      this.confirmTimer = null

      createWidget(widget.TEXT, {
        x: 0,
        y: 36,
        w: DEVICE_WIDTH,
        h: 52,
        text: 'File manager',
        text_size: 32,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: 20,
        y: 96,
        w: DEVICE_WIDTH - 40,
        h: 96,
        text: '',
        text_size: 24,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.uploadButton = createWidget(widget.BUTTON, {
        x: 70,
        y: 210,
        w: 340,
        h: 96,
        radius: 18,
        normal_color: 0x1e88e5,
        press_color: 0x155fa0,
        text: 'Send all',
        text_size: 30,
        click_func: () => this.uploadAll(),
      })

      this.deleteButton = createWidget(widget.BUTTON, {
        x: 70,
        y: 320,
        w: 340,
        h: 96,
        radius: 18,
        normal_color: 0x5a1f1f,
        press_color: 0x3f1616,
        text: 'Delete all',
        text_size: 30,
        click_func: () => this.deleteAll(),
      })

      this.refresh()
    },

    onResume() {
      this.refresh()
    },

    refresh() {
      if (this.busy) {
        // A send run owns this.notes by index — don't re-list under it.
        return
      }
      this.notes = listNotes()
      this.resetConfirm()
      if (this.notes.length === 0) {
        this.setStatus('No notes on watch')
      } else {
        const kb = Math.round((totalBytes(this.notes) / 1024) * 10) / 10
        this.setStatus(`${this.notes.length} note(s) · ${kb} KB`)
      }
    },

    setStatus(text) {
      if (this.destroyed) {
        return
      }
      this.statusWidget.text = text
    },

    resetConfirm() {
      if (this.confirmTimer) {
        clearTimeout(this.confirmTimer)
        this.confirmTimer = null
      }
      if (this.confirmDelete) {
        this.confirmDelete = false
        this.deleteButton.setProperty(prop.TEXT, 'Delete all')
      }
    },

    // --- upload ---------------------------------------------------------

    uploadAll() {
      if (this.busy || this.notes.length === 0) {
        return
      }
      this.resetConfirm()
      this.busy = true
      this.acquireScreen()
      this.sent = 0
      this.skipped = 0
      this.failed = 0
      this.uploadNext(0)
    },

    uploadNext(index) {
      if (index >= this.notes.length) {
        this.finishUpload()
        return
      }
      const note = this.notes[index]

      if (note.size > SANE_MAX_BYTES) {
        this.skipped += 1
        this.uploadNext(index + 1)
        return
      }

      let bytes
      try {
        bytes = new Uint8Array(readFileSync({ path: note.rel }))
      } catch (e) {
        this.failed += 1
        this.uploadNext(index + 1)
        return
      }
      if (bytes.length === 0) {
        this.removeFile(note.rel)
        this.uploadNext(index + 1)
        return
      }

      const uploadId = note.rel.replace(/\.opus$/, '')
      const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_RAW_BYTES))
      this.sendChunk(note, bytes, uploadId, chunkCount, 0, index)
    },

    sendChunk(note, bytes, uploadId, chunkCount, chunkIndex, index) {
      this.setStatus(
        chunkCount > 1
          ? `Sending ${index + 1}/${this.notes.length} (${chunkIndex + 1}/${chunkCount})…`
          : `Sending ${index + 1}/${this.notes.length}…`,
      )
      const start = chunkIndex * CHUNK_RAW_BYTES
      const end = Math.min(bytes.length, start + CHUNK_RAW_BYTES)
      base64FromBytes(bytes.subarray(start, end), (b64) => {
        if (this.destroyed) {
          return
        }
        this.postChunk(note, bytes, uploadId, chunkCount, chunkIndex, b64, index)
      })
    },

    postChunk(note, bytes, uploadId, chunkCount, chunkIndex, b64, index) {
      let settled = false
      const done = (fn) => {
        if (settled) {
          return
        }
        settled = true
        this.clearWatchdog()
        fn()
      }

      this.watchdog = setTimeout(() => {
        done(() => {
          this.failed += 1
          this.uploadNext(index + 1)
        })
      }, UPLOAD_WATCHDOG_MS)

      this.httpRequest({
        method: 'POST',
        url: CHUNK_ENDPOINT,
        headers: {
          'x-relay-token': RELAY_TOKEN,
          'content-type': 'text/plain',
          'x-audio-encoding': 'base64',
          'x-upload-id': uploadId,
          'x-chunk-index': String(chunkIndex),
          'x-chunk-count': String(chunkCount),
          'x-recorded-at': note.recordedAtMillis,
        },
        body: b64,
      })
        .then((res) => {
          done(() => {
            // httpRequest resolves for any completed response, not just 2xx.
            if (res && res.status >= 200 && res.status < 300) {
              if (chunkIndex + 1 >= chunkCount) {
                this.sent += 1
                this.removeFile(note.rel)
                this.uploadNext(index + 1)
              } else {
                this.sendChunk(note, bytes, uploadId, chunkCount, chunkIndex + 1, index)
              }
            } else {
              this.failed += 1
              this.uploadNext(index + 1)
            }
          })
        })
        .catch(() => {
          done(() => {
            this.failed += 1
            this.uploadNext(index + 1)
          })
        })
    },

    finishUpload() {
      this.busy = false
      this.releaseScreen()
      const parts = [`Sent ${this.sent}`]
      if (this.skipped) {
        parts.push(`${this.skipped} too large`)
      }
      if (this.failed) {
        parts.push(`${this.failed} failed`)
      }
      this.setStatus(parts.join(' · '))
      this.notes = listNotes()
    },

    removeFile(rel) {
      try {
        rmSync({ path: rel })
      } catch (e) {
        // best-effort — a stale file just shows up again next open
      }
    },

    clearWatchdog() {
      if (this.watchdog) {
        clearTimeout(this.watchdog)
        this.watchdog = null
      }
    },

    // --- delete --------------------------------------------------------

    deleteAll() {
      if (this.busy || this.notes.length === 0) {
        return
      }
      if (!this.confirmDelete) {
        this.confirmDelete = true
        this.deleteButton.setProperty(prop.TEXT, 'Tap again')
        this.confirmTimer = setTimeout(() => this.resetConfirm(), 3000)
        return
      }
      this.resetConfirm()
      let removed = 0
      for (const note of listNotes()) {
        this.removeFile(note.rel)
        removed += 1
      }
      this.notes = []
      this.setStatus(`Deleted ${removed}`)
    },

    // --- screen hold --------------------------------------------------

    acquireScreen() {
      if (this.brightHeld) {
        return
      }
      this.brightHeld = true
      try {
        display.setPageBrightTime({ brightTime: SCREEN_HOLD_MS })
      } catch (e) {
        // display API unavailable
      }
    },

    releaseScreen() {
      if (!this.brightHeld) {
        return
      }
      this.brightHeld = false
      try {
        if (typeof display.resetPageBrightTime === 'function') {
          display.resetPageBrightTime()
        } else {
          display.setPageBrightTime({ brightTime: 0 })
        }
      } catch (e) {
        // best-effort
      }
    },

    onDestroy() {
      this.destroyed = true
      this.clearWatchdog()
      if (this.confirmTimer) {
        clearTimeout(this.confirmTimer)
      }
      this.releaseScreen()
    },
  }),
)
