import { createWidget, widget, align } from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'

// urs-android's local relay listens on loopback only — the
// Zepp App's side-service does the actual fetch (app-side/index.js), it's
// on the same phone, so localhost is reachable without going through the
// backend's WireGuard tunnel at all.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const BEER_FILL_ENDPOINT = `${RELAY_BASE_URL}/api/watch/beer-fill`
const DEFAULT_VOLUME_ML = 500
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '33d248e9de3f6cd180d35718ca7d8464145a5dc3368535cc'

Page(
  BasePage({
    build() {
      createWidget(widget.TEXT, {
        x: 0,
        y: 80,
        w: 480,
        h: 80,
        text: 'urs — Beer',
        text_size: 36,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: 0,
        y: 160,
        w: 480,
        h: 60,
        text: '',
        text_size: 24,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      createWidget(widget.BUTTON, {
        x: 90,
        y: 220,
        w: 300,
        h: 120,
        radius: 20,
        normal_color: 0xf44336,
        press_color: 0xb71c1c,
        text: `+1 · ${DEFAULT_VOLUME_ML}ml`,
        text_size: 32,
        click_func: () => this.logFill(),
      })
    },

    logFill() {
      this.statusWidget.text = 'Sending…'
      this.httpRequest({
        method: 'POST',
        url: BEER_FILL_ENDPOINT,
        headers: { 'x-relay-token': RELAY_TOKEN },
      })
        .then((res) => {
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
          this.statusWidget.text = 'Failed — check phone'
        })
    },
  }),
)
