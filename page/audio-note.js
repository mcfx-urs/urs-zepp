import { createWidget, widget, align, prop } from '@zos/ui'
import { create, id, codec } from '@zos/media'
import { queryPermission, requestPermission } from '@zos/app'
import { setInterval, clearInterval, setTimeout, clearTimeout } from '@zos/timer'
import { statSync } from '@zos/fs'
import * as display from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// The Recorder needs mic access. Declared in app.json, but it is a dynamic
// permission — the user still has to grant it at runtime the first time.
const MIC_PERMISSION = 'device:os.mic'
const PERMISSION_GRANTED = 2

// This screen only records: it writes note-<ts>.opus to the data root and
// stops there. Getting the file to urs-android is page/audio-files' job, so
// a slow or failing upload can never block or delay a recording.
const BUTTON_IDLE = { normal_color: 0x1e88e5, press_color: 0x155fa0, text: 'Record' }
const BUTTON_REC = { normal_color: 0xe53935, press_color: 0xb71c1c, text: 'Stop' }

// After the STOP event the encoder may still be flushing — poll the file
// size and only act on it once it is non-zero.
const FILE_POLL_MS = 400
const FILE_POLL_MAX = 20
// The STOP event is not guaranteed to fire — poll anyway after this long.
const STOP_FALLBACK_MS = 1500

// Keep the screen awake while recording: a display timeout suspends the
// page, which freezes the elapsed timer and can cut the recording short.
const SCREEN_HOLD_MS = 10 * 60 * 1000

// Recording can't survive a real screen-off (onPause stops it — see below),
// so instead of dimming the display we keep it lit but reduce it to a thin
// faded ring at the screen edge after a few seconds of no interaction.
// Tapping anywhere restores the full UI and re-arms this timer.
const RING_DELAY_MS = 2000
const RING_LINE_WIDTH = 7
const RING_RADIUS = DEVICE_WIDTH / 2 - RING_LINE_WIDTH / 2
const RING_COLOR = 0x661a1a

// The recorder (target_file) takes a data:// URI; @zos/fs takes a path
// relative to /data. Derive both from one id and write to the data root —
// a data://download/ subdir is not created for us and the recorder then
// silently writes nothing.
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
      this.destroyed = false
      this.brightHolds = 0
      this.ringMode = false
      this.ringTimer = null

      this.titleWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 50,
        w: DEVICE_WIDTH,
        h: 56,
        text: 'Record',
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

      // Ring mode: created last so both sit above the widgets above and can
      // hide them from view. Hidden until enterRingMode() shows them.
      this.ringCatcher = createWidget(widget.FILL_RECT, {
        x: 0,
        y: 0,
        w: DEVICE_WIDTH,
        h: DEVICE_WIDTH,
        color: 0x000000,
        click_down: () => this.wakeFromRing(),
      })
      this.ringArc = createWidget(widget.ARC, {
        x: 0,
        y: 0,
        w: DEVICE_WIDTH,
        h: DEVICE_WIDTH,
        radius: RING_RADIUS,
        start_angle: 0,
        end_angle: 360,
        color: RING_COLOR,
        line_width: RING_LINE_WIDTH,
        click_down: () => this.wakeFromRing(),
      })
      this.ringCatcher.setProperty(prop.VISIBLE, false)
      this.ringArc.setProperty(prop.VISIBLE, false)
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
      this.acquireScreen()
      this.armRingTimer()
      this.setStatus('Recording…')
    },

    stopRecording() {
      this.clearRingTimer()
      this.exitRingMode()
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
      this.releaseScreen()
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer)
        this.stopFallbackTimer = null
      }
      this.waitForFile(1)
    },

    // The encoder keeps flushing after STOP — wait for a non-zero file
    // before declaring the note saved.
    waitForFile(attempt) {
      const size = fileSize(this.paths.rel)
      if (size > 0) {
        this.setStatus(`Saved ✓ · ${size} B — send it from File manager`)
        return
      }
      if (attempt >= FILE_POLL_MAX) {
        this.setStatus('No recording data')
        return
      }
      setTimeout(() => this.waitForFile(attempt + 1), FILE_POLL_MS)
    },

    // --- ring mode -------------------------------------------------------

    armRingTimer() {
      this.clearRingTimer()
      if (!this.recording) {
        return
      }
      this.ringTimer = setTimeout(() => this.enterRingMode(), RING_DELAY_MS)
    },

    clearRingTimer() {
      if (this.ringTimer) {
        clearTimeout(this.ringTimer)
        this.ringTimer = null
      }
    },

    enterRingMode() {
      if (this.ringMode || !this.recording) {
        return
      }
      this.ringMode = true
      this.setFullUiVisible(false)
      this.ringCatcher.setProperty(prop.VISIBLE, true)
      this.ringArc.setProperty(prop.VISIBLE, true)
    },

    exitRingMode() {
      if (!this.ringMode) {
        return
      }
      this.ringMode = false
      this.ringCatcher.setProperty(prop.VISIBLE, false)
      this.ringArc.setProperty(prop.VISIBLE, false)
      this.setFullUiVisible(true)
    },

    // Tap anywhere during ring mode: show the full UI again and re-arm the
    // timer so it collapses back to the ring after another idle period.
    wakeFromRing() {
      if (!this.ringMode) {
        return
      }
      this.exitRingMode()
      this.armRingTimer()
    },

    setFullUiVisible(visible) {
      this.titleWidget.setProperty(prop.VISIBLE, visible)
      this.statusWidget.setProperty(prop.VISIBLE, visible)
      this.elapsedWidget.setProperty(prop.VISIBLE, visible)
      this.button.setProperty(prop.VISIBLE, visible)
    },

    // Reference-counted screen-awake hold. Only recording takes one here,
    // but the counter keeps the release path uniform with onDestroy.
    acquireScreen() {
      this.brightHolds += 1
      if (this.brightHolds === 1) {
        try {
          display.setPageBrightTime({ brightTime: SCREEN_HOLD_MS })
        } catch (e) {
          // display API unavailable — recording still works, just not past
          // the screen timeout
        }
      }
    },

    releaseScreen(force) {
      if (force) {
        this.brightHolds = 0
      } else if (this.brightHolds > 0) {
        this.brightHolds -= 1
      }
      if (this.brightHolds > 0) {
        return
      }
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

    setRecording(on) {
      this.recording = on
      const style = on ? BUTTON_REC : BUTTON_IDLE
      this.button.setProperty(prop.MORE, style)
      // prop.MORE does not reliably update the label — set it explicitly.
      this.button.setProperty(prop.TEXT, style.text)
    },

    setStatus(text) {
      if (this.destroyed) {
        return
      }
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

    // Screen-off or app backgrounded mid-recording: stop and flush now so
    // the note is saved to disk, instead of risking a hard kill that leaves
    // a partial file. Distinct from the user tapping Stop.
    onPause() {
      if (this.recording) {
        this.stopRecording()
      }
    },

    onDestroy() {
      this.destroyed = true
      this.stopTimer()
      this.clearRingTimer()
      this.releaseScreen(true)
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
