import { BaseSideService } from '@zeppos/zml/base-side'

// zml's BaseSideService transparently relays this.httpRequest() calls made
// from the device-app side (page/index.page.js) over BLE, then performs the
// actual fetch here — this process runs inside the Zepp App on the phone,
// which has real network access, unlike the watch itself.
AppSideService(BaseSideService({}))
