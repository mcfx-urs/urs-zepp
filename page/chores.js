import { createWidget, widget, align, deleteWidget } from '@zos/ui'
import { push } from '@zos/router'
import { BasePage } from '@zeppos/zml/base-page'

const DEVICE_WIDTH = 480

// Same loopback relay as page/chore.js — the Zepp App side-service does the
// real fetch, so 127.0.0.1 reaches urs-android without the backend tunnel.
const RELAY_BASE_URL = 'http://127.0.0.1:8787'
const CHORE_TYPES_ENDPOINT = `${RELAY_BASE_URL}/api/watch/chore-types`
// Must match WATCH_RELAY_TOKEN in urs-android's WatchRelayToken.kt exactly.
const RELAY_TOKEN = '0'

// One row per chore type; the relay returns [{ typeId, name }, …].
const LIST_ITEM_CONFIG = [
  {
    type_id: 1,
    item_height: 100,
    item_bg_color: 0x1f1f1f,
    item_bg_radius: 16,
    text_view: [
      {
        x: 40,
        y: 0,
        w: DEVICE_WIDTH - 80,
        h: 100,
        key: 'name',
        color: 0xffffff,
        text_size: 32,
      },
    ],
    text_view_count: 1,
    image_view_count: 0,
  },
]

Page(
  BasePage({
    build() {
      this.inFlight = false
      this.types = []
      this.listWidget = null
      this.retryButton = null

      createWidget(widget.TEXT, {
        x: 0,
        y: 40,
        w: DEVICE_WIDTH,
        h: 60,
        text: 'Chores',
        text_size: 40,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.statusWidget = createWidget(widget.TEXT, {
        x: 20,
        y: 150,
        w: DEVICE_WIDTH - 40,
        h: 80,
        text: '',
        text_size: 28,
        color: 0x9e9e9e,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.loadTypes()
    },

    loadTypes() {
      if (this.inFlight) {
        return
      }
      this.inFlight = true
      this.statusWidget.text = 'Loading…'
      if (this.retryButton) {
        deleteWidget(this.retryButton)
        this.retryButton = null
      }

      this.httpRequest({
        method: 'GET',
        url: CHORE_TYPES_ENDPOINT,
        headers: { 'x-relay-token': RELAY_TOKEN },
      })
        .then((res) => {
          this.inFlight = false
          // zml's httpRequest resolves for any completed HTTP response, not
          // just 2xx — the status must be checked explicitly.
          if (!res || res.status < 200 || res.status >= 300) {
            this.showError(`Failed (${res && res.status}) — check phone`)
            return
          }
          let types
          try {
            types = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
          } catch (e) {
            this.showError('Bad response — check phone')
            return
          }
          if (!Array.isArray(types) || types.length === 0) {
            this.statusWidget.text = 'No chores configured'
            return
          }
          this.renderList(types)
        })
        .catch(() => {
          this.inFlight = false
          this.showError('Failed — check phone')
        })
    },

    renderList(types) {
      this.types = types
      this.statusWidget.text = ''

      this.listWidget = createWidget(widget.SCROLL_LIST, {
        x: 0,
        y: 120,
        w: DEVICE_WIDTH,
        h: 360,
        item_space: 12,
        item_config: LIST_ITEM_CONFIG,
        item_config_count: 1,
        data_array: types,
        data_count: types.length,
        data_type_config: [{ start: 0, end: types.length - 1, type_id: 1 }],
        data_type_config_count: 1,
        item_click_func: (list, index) => {
          const type = this.types[index]
          push({
            url: 'page/chore',
            params: JSON.stringify({ typeId: type.typeId, name: type.name }),
          })
        },
      })
    },

    showError(message) {
      this.statusWidget.text = message
      this.retryButton = createWidget(widget.BUTTON, {
        x: 120,
        y: 250,
        w: 240,
        h: 90,
        radius: 16,
        normal_color: 0x2e7d32,
        press_color: 0x1b5e20,
        text: 'Retry',
        text_size: 30,
        click_func: () => this.loadTypes(),
      })
    },
  }),
)
