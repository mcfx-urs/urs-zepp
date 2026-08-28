import { BaseSideService } from '@zeppos/zml/base-side'

// zml's BaseSideService transparently relays this.httpRequest() calls made
// from the device app over BLE and performs the actual fetch() here, inside
// the Zepp App on the phone, which has real network access unlike the watch.
// The audio-note PoC rides that path: the device reads its recording back
// and POSTs it base64-encoded to urs-android's loopback relay. Nothing
// app-specific is needed on this side.

AppSideService(BaseSideService({}))
