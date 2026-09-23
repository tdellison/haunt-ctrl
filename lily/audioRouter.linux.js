// ─── Lily audio router — LINUX (the real one) ────────────────────────────────
//
// The only file in the project allowed to touch bluetoothctl (BlueZ) or wpctl
// (PipeWire/WirePlumber). Runs on the OptiPlex. See audioRouter.js for the
// interface contract and the platform-selection rule.
//
// Realities this file works around:
//   - A Classic BT connect "succeeding" does NOT mean audio can flow yet:
//     PipeWire publishes the bluez sink a beat later. waitForSink() polls
//     `wpctl status` until the sink shows up (the "patience loop") so
//     routeAudioOutput() never races it.
//   - Pairings go stale (Lily power-cycled, BlueZ cache out of sync) and then
//     pair/connect fail forever until the device is removed. Both pair() and
//     connect() do one remove-and-retry pass before giving up.
//   - BT speakers nap their amp and clip the first ~300ms of audio. Every
//     playBuffer() prepends a short low tone (generated once with ffmpeg) so
//     the amp is awake when the actual line starts.
//
// NOT YET VALIDATED ON THE OPTIPLEX - built from the integration spec's 2.2
// addendum. When the Linux box is up, test pair/connect/route/play end to end
// and reconcile any bluetoothctl output differences here, nowhere else.

'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  deviceName: 'Lily',        // BT display name, used to spot the sink in wpctl
  log: (msg) => console.log(`[LILY-AUDIO] ${msg}`),
  sinkTimeoutMs: 20000,      // patience loop: how long to wait for the sink
  sinkPollMs: 500,           // patience loop: poll interval
  scanSeconds: 12,           // discovery window before pairing
  cmdTimeoutMs: 20000,       // hard cap per shell-out
  wakeToneHz: 200,           // low + quiet: wakes the amp, unnoticed by guests
  wakeToneMs: 350,
  wakeToneVolume: 0.4,
  ffplayBin: 'ffplay',       // from PATH on Linux (unlike the Dell's pinned path)
  ffmpegBin: 'ffmpeg',
  bluetoothctlBin: 'bluetoothctl',
  wpctlBin: 'wpctl',
};

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`, err });
    });
  });
}

class LinuxLilyAudioRouter {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.address = opts.deviceAddress || null;
    this.sinkId = null;
    this.wakeTonePath = path.join(os.tmpdir(), 'lily-wake-tone.wav');
    this.isReal = true;
  }

  _bt(args) { return run(this.o.bluetoothctlBin, args, this.o.cmdTimeoutMs); }
  _wpctl(args) { return run(this.o.wpctlBin, args, this.o.cmdTimeoutMs); }

  async _scan() {
    // One-shot discovery window; bluetoothctl exits when --timeout elapses.
    await this._bt(['--timeout', String(this.o.scanSeconds), 'scan', 'on']);
  }

  async pair(deviceAddress) {
    const addr = deviceAddress || this.address;
    if (!addr) throw new Error('Lily pair: no device address configured');
    this.address = addr;
    const { log } = this.o;

    await this._bt(['power', 'on']);
    log(`Scanning ${this.o.scanSeconds}s for ${addr}…`);
    await this._scan();

    let res = await this._bt(['pair', addr]);
    if (!res.ok && /AlreadyExists/i.test(res.out)) {
      log('Already paired.');
    } else if (!res.ok) {
      // Stale-pairing recovery: remove the cached device and go around once.
      log(`Pair failed (${res.out.trim().slice(0, 120)}) - removing stale pairing and retrying`);
      await this._bt(['remove', addr]);
      await this._scan();
      res = await this._bt(['pair', addr]);
      if (!res.ok) throw new Error(`Lily pair failed after stale-pairing recovery: ${res.out.trim()}`);
    }
    // Trust so BlueZ allows Lily to reconnect on its own after power cycles.
    await this._bt(['trust', addr]);
    log(`Paired + trusted ${addr}`);
  }

  async connect(deviceAddress) {
    const addr = deviceAddress || this.address;
    if (!addr) throw new Error('Lily connect: no device address configured');
    this.address = addr;
    const { log } = this.o;

    let res = await this._bt(['connect', addr]);
    if (!res.ok) {
      log(`Connect failed (${res.out.trim().slice(0, 120)}) - stale-pairing recovery`);
      await this._bt(['remove', addr]);
      await this._scan();
      const paired = await this._bt(['pair', addr]);
      if (!paired.ok) throw new Error(`Lily re-pair during connect failed: ${paired.out.trim()}`);
      await this._bt(['trust', addr]);
      res = await this._bt(['connect', addr]);
      if (!res.ok) throw new Error(`Lily connect failed after recovery: ${res.out.trim()}`);
    }
    log(`Connected ${addr} - waiting for audio sink to publish`);
    await this._waitForSink();
  }

  // The patience loop. PipeWire names bluez sinks after the MAC
  // (bluez_output.AA_BB_CC_DD_EE_FF.1), but `wpctl status` prints the friendly
  // device name in its Sinks block, so match either the name or 'bluez'.
  async _waitForSink() {
    const deadline = Date.now() + this.o.sinkTimeoutMs;
    while (Date.now() < deadline) {
      const id = await this._findSinkId();
      if (id !== null) {
        this.sinkId = id;
        this.o.log(`Sink published (wpctl id ${id})`);
        return;
      }
      await new Promise(r => setTimeout(r, this.o.sinkPollMs));
    }
    throw new Error(`Lily sink never published within ${this.o.sinkTimeoutMs}ms - is A2DP up?`);
  }

  async _findSinkId() {
    const res = await this._wpctl(['status']);
    if (!res.ok) return null;
    const sinksBlock = res.out.split(/Sinks:/i)[1];
    if (!sinksBlock) return null;
    const lines = sinksBlock.split('\n');
    for (const line of lines) {
      if (/Sources:|Filters:|Streams:/i.test(line)) break; // end of Sinks block
      const m = line.match(/(\d+)\.\s+(.+?)(\s+\[|$)/);
      if (!m) continue;
      const name = m[2].trim();
      const macToken = this.address ? this.address.replace(/:/g, '_') : null;
      if (name.toLowerCase().includes(this.o.deviceName.toLowerCase()) ||
          /bluez/i.test(name) ||
          (macToken && line.includes(macToken))) {
        return parseInt(m[1], 10);
      }
    }
    return null;
  }

  async routeAudioOutput() {
    if (this.sinkId === null) await this._waitForSink();
    const res = await this._wpctl(['set-default', String(this.sinkId)]);
    if (!res.ok) throw new Error(`wpctl set-default ${this.sinkId} failed: ${res.out.trim()}`);
    this.o.log(`Default sink -> Lily (id ${this.sinkId})`);
  }

  async _ensureWakeTone() {
    if (fs.existsSync(this.wakeTonePath)) return true;
    const { wakeToneHz, wakeToneMs, wakeToneVolume } = this.o;
    const res = await run(this.o.ffmpegBin, [
      '-y', '-f', 'lavfi',
      '-i', `sine=frequency=${wakeToneHz}:duration=${wakeToneMs / 1000}`,
      '-filter:a', `volume=${wakeToneVolume}`,
      this.wakeTonePath,
    ], this.o.cmdTimeoutMs);
    if (!res.ok) this.o.log(`Wake tone generation failed (${res.out.trim().slice(0, 120)}) - playing without it`);
    return res.ok;
  }

  _playFile(file) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.o.ffplayBin, ['-nodisp', '-autoexit', '-loglevel', 'error', file]);
      p.on('error', reject);
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffplay exit ${code}`)));
    });
  }

  async playBuffer(audioBuffer) {
    const tmp = path.join(os.tmpdir(), `lily-line-${Date.now()}.audio`);
    fs.writeFileSync(tmp, audioBuffer);
    try {
      if (await this._ensureWakeTone()) await this._playFile(this.wakeTonePath);
      await this._playFile(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async disconnect() {
    if (!this.address) return;
    await this._bt(['disconnect', this.address]);
    this.sinkId = null;
    this.o.log(`Disconnected ${this.address}`);
  }
}

module.exports = { create: (opts) => new LinuxLilyAudioRouter(opts) };
