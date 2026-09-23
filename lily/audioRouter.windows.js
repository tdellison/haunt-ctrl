// ─── Lily audio router — WINDOWS (laptop stub) ────────────────────────────────
//
// Same interface as audioRouter.linux.js, zero real Classic BT audio routing.
// Windows has no bluetoothctl/wpctl and its BT-audio API surface is a
// different world - so this stub NEVER shells out to either. It exists so
// every OTHER piece of the Lily integration (BLE movement/lighting/safety,
// dialogue selection, agent logic) can be built and tested on the laptop with
// real Lily hardware, and carries to the OptiPlex without a rewrite.
//
// What it does instead:
//   - pair/connect/route/disconnect log what the real router WOULD have done.
//   - playBuffer gives audible feedback through the laptop's normal speakers:
//     a supplied playLocalBuffer callback if the caller wired one in (server.js
//     should pass its own playerBin/playerArgs pipeline), else a direct ffplay
//     spawn using the Dell's pinned path / FFPLAY_PATH. It is NOT Lily's
//     onboard speaker and never will be - that's the point of the boundary.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same pinned build the Dell uses (server.js FFPLAY_PATH); env var overrides.
const DEFAULT_FFPLAY = process.env.FFPLAY_PATH ||
  'C:\\ffmpeg\\ffmpeg-2026-09-10-git-fd7c73d01e-full_build\\bin\\ffplay.exe';

class WindowsLilyAudioRouterStub {
  constructor(opts = {}) {
    this.log = opts.log || ((msg) => console.log(`[LILY-AUDIO stub] ${msg}`));
    this.address = opts.deviceAddress || null;
    this.playLocalBuffer = opts.playLocalBuffer || null; // async (Buffer) => void
    this.localPlayback = opts.localPlayback !== false;   // false = log-only
    this.ffplayBin = opts.ffplayBin || DEFAULT_FFPLAY;
    this.isReal = false;
  }

  async pair(deviceAddress) {
    this.address = deviceAddress || this.address;
    this.log(`would pair + trust ${this.address} here (bluetoothctl on Linux)`);
  }

  async connect(deviceAddress) {
    this.address = deviceAddress || this.address;
    this.log(`would connect ${this.address} and wait for the A2DP sink to publish`);
  }

  async routeAudioOutput() {
    this.log('would route audio to Lily here (wpctl set-default on Linux)');
  }

  async playBuffer(audioBuffer) {
    this.log(`would play ${audioBuffer.length} bytes through Lily's onboard speaker (wake tone prepended)`);
    if (!this.localPlayback) return;
    try {
      if (this.playLocalBuffer) return await this.playLocalBuffer(audioBuffer);
      const tmp = path.join(os.tmpdir(), `lily-line-${Date.now()}.audio`);
      fs.writeFileSync(tmp, audioBuffer);
      try {
        await new Promise((resolve, reject) => {
          const p = spawn(this.ffplayBin, ['-nodisp', '-autoexit', '-loglevel', 'error', tmp]);
          p.on('error', reject);
          p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffplay exit ${code}`)));
        });
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    } catch (e) {
      // Feedback is a nicety; a missing ffplay must never fail the caller.
      this.log(`local playback unavailable (${e.message}) - logged only`);
    }
  }

  async disconnect() {
    this.log(`would disconnect ${this.address}`);
  }
}

module.exports = { create: (opts) => new WindowsLilyAudioRouterStub(opts) };
