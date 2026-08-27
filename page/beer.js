import { createWidget, widget, align, prop } from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// urs-android's local relay listens on loopback only — the
// Zepp App's side-service does the actual fetch (app-side/index.js), it's
// on the same phone, so localhost is reachable without going through the
// backend's WireGuard tunnel at all.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const BEER_FILL_ENDPOINT = `${RELAY_BASE_URL}/api/watch/beer-fill`
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '0'

const VOLUMES_ML = [330, 500]

const BUTTON_IDLE = { normal_color: 0xf44336, press_color: 0xb71c1c }
const BUTTON_BUSY = { normal_color: 0x611712, press_color: 0x611712 }

Page(
  BasePage({
    build() {
      this.inFlight = false
      this.buttons = []

      createWidget(widget.TEXT, {
        x: 0,
        y: 60,
        w: DEVICE_WIDTH,
        h: 60,
        text: 'Beer Counter',
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

      VOLUMES_ML.forEach((volume, index) => {
        const button = createWidget(widget.BUTTON, {
          x: 90,
          y: 200 + index * 130,
          w: 300,
          h: 110,
          radius: 20,
          normal_color: BUTTON_IDLE.normal_color,
          press_color: BUTTON_IDLE.press_color,
          text: `+${volume}ml`,
          text_size: 32,
          click_func: () => this.logFill(volume),
        })
        this.buttons.push(button)
      })
    },

    // Block further taps and dim both buttons while a request is out —
    // the BLE round-trip is short, but a double-tap in that window would
    // log twice.
    setBusy(busy) {
      this.inFlight = busy
      const colors = busy ? BUTTON_BUSY : BUTTON_IDLE
      this.buttons.forEach((button) => button.setProperty(prop.MORE, colors))
    },

    logFill(volume) {
      if (this.inFlight) {
        return
      }
      this.setBusy(true)
      this.statusWidget.text = 'Sending…'

      this.httpRequest({
        method: 'POST',
        url: `${BEER_FILL_ENDPOINT}?volume=${volume}`,
        headers: { 'x-relay-token': RELAY_TOKEN },
      })
        .then((res) => {
          this.setBusy(false)
          // zml's httpRequest resolves for any completed HTTP response, not
          // just 2xx (matches standard fetch() semantics) — status must be
          // checked explicitly, or a 401/503/500 from the relay silently
          // shows as success here.
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
