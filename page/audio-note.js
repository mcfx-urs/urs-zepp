import { createWidget, widget, align, prop } from '@zos/ui'
import { create, id } from '@zos/media'
import { setInterval, clearInterval } from '@zos/timer'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// PoC only (urs-zepp#4): record a short note, transfer it to the phone,
// which POSTs the bytes to urs-android's loopback relay. Nothing here is
// meant to be polished — it proves the Recorder + BLE file-transfer chain.

const BUTTON_IDLE = { normal_color: 0x1e88e5, press_color: 0x155fa0, text: 'Record' }
const BUTTON_REC = { normal_color: 0xe53935, press_color: 0xb71c1c, text: 'Stop' }

// data:// path the Recorder writes to; the same path is handed to sendFile.
function targetFile() {
  return `data://download/note-${Date.now()}.opus`
}

Page(
  BasePage({
    build() {
      this.recording = false
      this.elapsed = 0
      this.timer = null
      this.filePath = null

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
        h: 44,
        text: 'Idle',
        text_size: 24,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.elapsedWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 168,
        w: DEVICE_WIDTH,
        h: 44,
        text: '0s',
        text_size: 28,
        color: 0xffffff,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.button = createWidget(widget.BUTTON, {
        x: 90,
        y: 240,
        w: 300,
        h: 120,
        radius: 20,
        normal_color: BUTTON_IDLE.normal_color,
        press_color: BUTTON_IDLE.press_color,
        text: 'Record',
        text_size: 32,
        click_func: () => this.toggle(),
      })

      this.initRecorder()
    },

    initRecorder() {
      this.recorder = create(id.RECORDER)
      this.filePath = targetFile()

      // Constant names below (codec/format enums) are the parts that need
      // verifying on a real Active Max — see the nightrun report.
      this.recorder.setFormat({
        target_file: this.filePath,
        format: 'opus',
        codec: 'opus',
        num_channels: 1,
        sampling_rate: 16000,
        bit_rate: 24000,
      })

      this.recorder.addEventListener(this.recorder.event.PREPARE, (ok) => {
        if (ok) {
          this.recorder.start()
        } else {
          this.setStatus('Prepare failed')
          this.setRecording(false)
        }
      })
      this.recorder.addEventListener(this.recorder.event.START, () => {
        this.setStatus('Recording…')
        this.startTimer()
      })
      this.recorder.addEventListener(this.recorder.event.STOP, () => {
        this.stopTimer()
        this.setStatus('Sending to phone…')
        this.sendRecording()
      })
    },

    toggle() {
      if (this.recording) {
        this.setRecording(false)
        this.recorder.stop()
      } else {
        this.setRecording(true)
        this.elapsed = 0
        this.elapsedWidget.text = '0s'
        this.filePath = targetFile()
        this.recorder.setFormat({
          target_file: this.filePath,
          format: 'opus',
          codec: 'opus',
          num_channels: 1,
          sampling_rate: 16000,
          bit_rate: 24000,
        })
        this.recorder.prepare()
      }
    },

    sendRecording() {
      // zml wraps @zos/ble file transfer — no need to import @zos/file-transfer.
      try {
        this.sendFile(this.filePath, { type: 'opus' })
          .then(() => this.setStatus('Sent ✓'))
          .catch((e) => this.setStatus(`Send failed: ${e && e.message}`))
      } catch (e) {
        this.setStatus(`Send threw: ${e && e.message}`)
      }
    },

    setRecording(on) {
      this.recording = on
      this.button.setProperty(prop.MORE, on ? BUTTON_REC : BUTTON_IDLE)
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
      if (this.recorder) {
        try {
          this.recorder.release()
        } catch (e) {
          // best-effort
        }
      }
    },
  }),
)
