import { createWidget, widget, align, prop } from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { RELAY_TOKEN } from '../utils/relay-token'

const DEVICE_WIDTH = 480

// Same loopback relay as page/beer.js — the Zepp App side-service does the
// real fetch, so 127.0.0.1 reaches urs-android without the backend tunnel.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const CHORE_EVENT_ENDPOINT = `${RELAY_BASE_URL}/api/watch/chore-event`

const BUTTON_IDLE = { normal_color: 0x2e7d32, press_color: 0x1b5e20 }
const BUTTON_BUSY = { normal_color: 0x14401a, press_color: 0x14401a }

Page(
  BasePage({
    onInit(param) {
      // page/index.js passes {"typeId","name"} as a JSON string.
      this.params = {}
      if (param) {
        try {
          this.params = JSON.parse(param)
        } catch (e) {
          this.params = {}
        }
      }
    },

    build() {
      this.inFlight = false
      const name = (this.params && this.params.name) || 'Chore'
      this.typeId = this.params && this.params.typeId

      createWidget(widget.TEXT, {
        x: 0,
        y: 60,
        w: DEVICE_WIDTH,
        h: 60,
        text: name,
        text_size: 36,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 130,
        w: DEVICE_WIDTH,
        h: 48,
        text: '',
        text_size: 24,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.button = createWidget(widget.BUTTON, {
        x: 90,
        y: 220,
        w: 300,
        h: 120,
        radius: 20,
        normal_color: BUTTON_IDLE.normal_color,
        press_color: BUTTON_IDLE.press_color,
        text: 'Log now',
        text_size: 32,
        click_func: () => this.logNow(),
      })

      if (!this.typeId) {
        this.statusWidget.text = 'No type configured'
      }
    },

    setBusy(busy) {
      this.inFlight = busy
      this.button.setProperty(prop.MORE, busy ? BUTTON_BUSY : BUTTON_IDLE)
    },

    logNow() {
      if (this.inFlight || !this.typeId) {
        return
      }
      this.setBusy(true)
      this.statusWidget.text = 'Sending…'

      this.httpRequest({
        method: 'POST',
        url: `${CHORE_EVENT_ENDPOINT}?typeId=${this.typeId}`,
        headers: { 'x-relay-token': RELAY_TOKEN },
      })
        .then((res) => {
          this.setBusy(false)
          // zml's httpRequest resolves for any completed HTTP response, not
          // just 2xx — the status must be checked explicitly.
          if (res && res.status >= 200 && res.status < 300) {
            this.statusWidget.text = 'Logged ✓'
          } else {
            this.statusWidget.text = `Failed (${res && res.status}) — check phone`
          }
        })
        .catch(() => {
          this.setBusy(false)
          this.statusWidget.text = 'Failed — check phone'
        })
    },
  }),
)
