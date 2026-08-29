import { createWidget, widget, align } from '@zos/ui'
import { push } from '@zos/router'

const DEVICE_WIDTH = 480

// Audio notes split into two screens so a stalled or slow upload can never
// block recording: page/audio-note only records (file to disk), page/
// audio-files sends the saved files to the phone and clears them.
const ENTRIES = [
  { name: '⏺ Record', url: 'page/audio-note' },
  { name: '📁 File manager', url: 'page/audio-files' },
]

Page({
  build() {
    createWidget(widget.TEXT, {
      x: 0,
      y: 40,
      w: DEVICE_WIDTH,
      h: 60,
      text: 'Audio note',
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
      data_array: ENTRIES,
      data_count: ENTRIES.length,
      data_type_config: [{ start: 0, end: ENTRIES.length - 1, type_id: 1 }],
      data_type_config_count: 1,
      item_click_func: (list, index) => {
        push({ url: ENTRIES[index].url })
      },
    })
  },
})
