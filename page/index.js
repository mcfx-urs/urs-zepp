import { createWidget, widget, align } from '@zos/ui'
import { push } from '@zos/router'

const DEVICE_WIDTH = 480

// Chore types exposed on the wrist — a fixed short list to start. Each
// typeId must be a real tracker_type_id from urs-backend for the phone
// relay to log against; update these to match the account before use.
const CHORE_TYPES = [
  { name: 'Bedsheets', typeId: '1' },
  { name: 'Water plants', typeId: '2' },
  { name: 'Vacuum', typeId: '3' },
]

// Top-level menu. Each entry opens its own counter submenu; further
// counters (and their sub-actions) get appended here as they are built.
const COUNTERS = [
  { name: 'Beer Counter', url: 'page/beer' },
  ...CHORE_TYPES.map((type) => ({
    name: type.name,
    url: 'page/chore',
    params: JSON.stringify({ typeId: type.typeId, name: type.name }),
  })),
  { name: 'Audio note (PoC)', url: 'page/audio-note' },
]

Page({
  build() {
    createWidget(widget.TEXT, {
      x: 0,
      y: 40,
      w: DEVICE_WIDTH,
      h: 60,
      text: 'URS',
      text_size: 40,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
    })

    createWidget(widget.SCROLL_LIST, {
      x: 0,
      y: 120,
      w: DEVICE_WIDTH,
      h: 360,
      item_space: 12,
      item_config: [
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
      ],
      item_config_count: 1,
      data_array: COUNTERS,
      data_count: COUNTERS.length,
      data_type_config: [{ start: 0, end: COUNTERS.length - 1, type_id: 1 }],
      data_type_config_count: 1,
      item_click_func: (list, index) => {
        const entry = COUNTERS[index]
        push({ url: entry.url, params: entry.params })
      },
    })
  },
})
