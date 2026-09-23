// ─── Lily audio router — platform selector ───────────────────────────────────
//
// Lily's onboard speaker is Bluetooth CLASSIC audio (A2DP), which is the ONE
// piece of the Lily integration that cannot run identically on both dev
// machines. Everything else (BLE GATT movement/lighting/safety via
// @abandonware/noble, dialogue selection, agent logic) is cross-platform.
//
//   - Linux OptiPlex (the real show machine): BlueZ `bluetoothctl` pairs and
//     connects, PipeWire/WirePlumber `wpctl` routes the sink. Implemented in
//     audioRouter.linux.js.
//   - Windows laptop (fast iteration): no bluetoothctl/wpctl equivalent
//     exists. audioRouter.windows.js is a stub with the SAME surface - it
//     logs what it would have done and can play the buffer through the
//     laptop's normal speakers so testing has audible feedback.
//
// THE RULE: nothing outside audioRouter.linux.js may reference bluetoothctl
// or wpctl. Call sites import THIS file and speak only the interface below,
// so the movement/lighting/dialogue work built on the laptop carries to the
// OptiPlex unchanged - only the audio leg swaps.
//
// Interface (both implementations, all methods async):
//   pair(deviceAddress)     - pair + trust Lily (idempotent; recovers a stale
//                             pairing by removing and re-pairing)
//   connect(deviceAddress)  - Classic BT connect, then wait for the audio
//                             sink to actually publish before resolving
//   routeAudioOutput()      - make Lily the active/default output sink
//   playBuffer(buffer)      - play generated speech, wake tone prepended so
//                             the speaker's amp is awake for the first word
//   disconnect()            - drop the Classic BT link
//
// Selection: LILY_AUDIO_ROUTER env var wins ('linux' forces the real one,
// 'stub' forces the stub - handy for dry-running on the OptiPlex), otherwise
// process.platform decides.

'use strict';

function createLilyAudioRouter(opts = {}) {
  const forced = (process.env.LILY_AUDIO_ROUTER || '').toLowerCase();
  const useLinux = forced === 'linux' ? true
    : forced === 'stub' ? false
    : process.platform === 'linux';
  const impl = useLinux ? require('./audioRouter.linux') : require('./audioRouter.windows');
  return impl.create(opts);
}

module.exports = { createLilyAudioRouter };
