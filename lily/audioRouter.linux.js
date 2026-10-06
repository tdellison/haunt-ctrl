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
  deviceName: 'Lily',        // VERIFY via live scan — reference prop advertised
                             // as 'Skelly(Live)'; Lily's Classic BT name is
                             // likely a variant pattern, never assume it.
  log: (msg) => console.log(`[LILY-AUDIO] ${msg}`),
  // Patience loop: on a fresh boot PipeWire can take up to ~60s AFTER BlueZ
  // says "connected" before the A2DP sink publishes. Poll slow, don't fail fast.
  sinkTimeoutMs: 60000,
  sinkPollMs: 500,
  scanSeconds: 12,           // discovery window before pairing (bredr scan)
  cmdTimeoutMs: 20000,       // hard cap per shell-out
  // Wake tone per spec 2.2.7: 92 Hz sine at ~-45 dBFS (~0.55% of full scale)
  // for ~0.65s — inaudible through the prop speaker in practice, but keeps the
  // BT link from clipping the first word of every line.
  // Tuned on the real prop 2026-10-04: at the original -45 dBFS / 650 ms her
  // movement started AFTER the voice; at ~-22 dBFS (0.08) / 700 ms, joined to
  // the line as one file, she moves on the first word.
  wakeToneHz: 92,
  wakeToneMs: 700,
  wakeToneVolume: 0.08,
  ffplayBin: 'ffplay',       // from PATH on Linux (unlike the Dell's pinned path)
  ffmpegBin: 'ffmpeg',
  bluetoothctlBin: 'bluetoothctl',
  wpctlBin: 'wpctl',
};

// Stale-pairing symptoms (spec 2.2.5): a factory reset / re-pair invalidates
// the stored link key but BlueZ keeps the stale device record. Only these
// failures warrant the remove-rescan-repair recovery pass; anything else is a
// real error to surface, not to paper over with a remove.
const STALE_PAIRING_MARKERS = /authentication canceled|authentication failed|connection attempt failed|AlreadyExists|Failed to pair|br-connection/i;

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
    this.sinkName = null;
    this.setWakeTone({});
    this.isReal = true;
  }

  _bt(args) { return run(this.o.bluetoothctlBin, args, this.o.cmdTimeoutMs); }
  _wpctl(args) { return run(this.o.wpctlBin, args, this.o.cmdTimeoutMs); }

  async _scan() {
    // One-shot CLASSIC (BR/EDR) discovery window — the audio endpoint is
    // Classic BT, not BLE, so scan bredr; bluetoothctl exits at --timeout.
    await this._bt(['--timeout', String(this.o.scanSeconds), 'scan', 'bredr']);
  }

  async pair(deviceAddress) {
    const addr = deviceAddress || this.address;
    if (!addr) throw new Error('Lily pair: no device address configured');
    this.address = addr;
    const { log } = this.o;

    await this._bt(['power', 'on']);
    log(`Scanning ${this.o.scanSeconds}s for ${addr}…`);
    await this._scan();

    // First-time pairing with a PIN needs an interactive agent (the spec's
    // `--agent KeyboardOnly` + fed PIN). One-shot bluetoothctl can't feed a
    // PIN, so do the very first pair by hand on the OptiPlex once; every run
    // after that only needs connect (the link key is stored). This one-shot
    // pair still succeeds for PIN-less props and already-known devices.
    let res = await this._bt(['pair', addr]);
    if (!res.ok && /AlreadyExists/i.test(res.out)) {
      log('Already paired.');
    } else if (!res.ok && STALE_PAIRING_MARKERS.test(res.out)) {
      // Stale-pairing recovery: remove the cached device, wait a beat, rescan,
      // and retry ONCE clean. Anything failing after that is a real problem.
      log(`Pair failed (${res.out.trim().slice(0, 120)}) - removing stale pairing and retrying`);
      await this._bt(['remove', addr]);
      await new Promise(r => setTimeout(r, 1000));
      await this._scan();
      res = await this._bt(['pair', addr]);
      if (!res.ok) throw new Error(`Lily pair failed after stale-pairing recovery: ${res.out.trim()}`);
    } else if (!res.ok) {
      throw new Error(`Lily pair failed (not a stale-pairing signature): ${res.out.trim()}`);
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
    // "not available": BlueZ hasn't seen her speaker since it appeared (it only
    // shows up after live mode). A discovery pass makes it visible; retry once.
    if (!res.ok && /not available/i.test(res.out)) {
      log('Speaker not visible yet - scanning, then retrying');
      await this._scan();
      res = await this._bt(['connect', addr]);
    }
    if (!res.ok && STALE_PAIRING_MARKERS.test(res.out)) {
      log(`Connect failed (${res.out.trim().slice(0, 120)}) - stale-pairing recovery`);
      await this._bt(['remove', addr]);
      await new Promise(r => setTimeout(r, 1000));
      await this._scan();
      const paired = await this._bt(['pair', addr]);
      if (!paired.ok) throw new Error(`Lily re-pair during connect failed: ${paired.out.trim()}`);
      await this._bt(['trust', addr]);
      res = await this._bt(['connect', addr]);
      if (!res.ok) throw new Error(`Lily connect failed after recovery: ${res.out.trim()}`);
    } else if (!res.ok) {
      throw new Error(`Lily connect failed (not a stale-pairing signature): ${res.out.trim()}`);
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
    const macToken = this.address ? this.address.replace(/:/g, '_').toUpperCase() : null;
    for (const line of sinksBlock.split('\n')) {
      if (/Sources:|Filters:|Streams:/i.test(line)) break; // end of Sinks block
      const m = line.match(/(\d+)\.\s+(.+?)(\s+\[|$)/);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      // The friendly name in `wpctl status` is whatever Lily advertises, so
      // the reliable match is the node name, which BlueZ builds from the MAC
      // (bluez_output.AA_BB_CC_DD_EE_FF.1). Never grab some other bluez sink.
      if (macToken) {
        const name = await this._sinkName(id);
        if (name && name.toUpperCase().includes(macToken)) return id;
      } else if (m[2].toLowerCase().includes(this.o.deviceName.toLowerCase())) {
        return id;
      }
    }
    return null;
  }

  // Resolve the PipeWire node.name for a wpctl id — ffplay targets a sink by
  // NAME (PULSE_SINK), never by the numeric id, which changes between runs.
  async _sinkName(id) {
    const res = await this._wpctl(['inspect', String(id)]);
    const m = res.ok && res.out.match(/node\.name = "([^"]+)"/);
    return m ? m[1] : null;
  }

  // Lily's sink is made the target of LILY'S playback only. It is deliberately
  // NOT made the system default: the rest of the show plays through the
  // default output (to the Onkyo), and a set-default here would silently
  // reroute every skeleton, storm and ambient sound into Lily's speaker.
  // Is her Bluetooth sink actually present right now? PipeWire silently
  // re-routes a stream whose PULSE_SINK is missing to the DEFAULT output (the
  // Onkyo), so this must be checked before every line (2026-10-05: her speaker
  // dropped mid-conversation and her voice came out of the yard speakers).
  async sinkPresent() {
    if (!this.address) return false;
    const id = await this._findSinkId();
    if (id === null) return false;
    this.sinkId = id;
    this.sinkName = await this._sinkName(id) || this.sinkName;
    return !!this.sinkName;
  }

  async routeAudioOutput() {
    if (this.sinkId === null) await this._waitForSink();
    this.sinkName = await this._sinkName(this.sinkId);
    if (!this.sinkName) throw new Error(`Could not resolve node name for Lily sink ${this.sinkId}`);
    // Unity gain (spec 2.2.4): Lily's jaw appears audio-reactive to loudness
    // through her own speaker — a quiet line level may mean NO jaw movement at
    // all, so 1.0 is a functional requirement to verify, not a nicety.
    const vol = await this._wpctl(['set-volume', String(this.sinkId), '1.0']);
    if (!vol.ok) this.o.log(`set-volume 1.0 failed (${vol.out.trim().slice(0, 80)}) - jaw sync may suffer`);
    this.o.log(`Lily playback -> ${this.sinkName} (id ${this.sinkId}), volume 1.0; system default untouched`);
  }

  // Pre-roll ("wake tone"). On the real prop (2026-10-04) her movement is
  // driven by the sound she plays, and starts a beat AFTER the voice. A low hum
  // loud enough for her motion to register — but too low for her small speaker
  // to reproduce well — gets her moving before the first word. setWakeTone()
  // tunes it live; each setting gets its own cached file.
  setWakeTone({ hz, ms, volume } = {}) {
    if (hz !== undefined) this.o.wakeToneHz = Number(hz);
    if (ms !== undefined) this.o.wakeToneMs = Number(ms);
    if (volume !== undefined) this.o.wakeToneVolume = Number(volume);
    const { wakeToneHz: h, wakeToneMs: m, wakeToneVolume: v } = this.o;
    this.wakeTonePath = path.join(os.tmpdir(), `lily-wake-${h}hz-${m}ms-${v}.wav`);
    return { hz: h, ms: m, volume: v };
  }

  async _ensureWakeTone() {
    if (!this.o.wakeToneMs || !this.o.wakeToneVolume) return false;
    if (fs.existsSync(this.wakeTonePath)) return true;
    const { wakeToneHz, wakeToneMs, wakeToneVolume } = this.o;
    // aevalsrc (not the sine source, whose amplitude is fixed) so the tone is
    // generated at EXACTLY wakeToneVolume of full scale: 0.0055 ~= -45 dBFS.
    const res = await run(this.o.ffmpegBin, [
      '-y', '-f', 'lavfi',
      '-i', `aevalsrc=${wakeToneVolume}*sin(2*PI*${wakeToneHz}*t):s=44100:d=${wakeToneMs / 1000}`,
      this.wakeTonePath,
    ], this.o.cmdTimeoutMs);
    if (!res.ok) this.o.log(`Wake tone generation failed (${res.out.trim().slice(0, 120)}) - playing without it`);
    return res.ok;
  }

  _playFile(file) {
    if (!this.sinkName) return Promise.reject(new Error('Lily audio not routed - connect her speaker first'));
    // PULSE_SINK pins this one ffplay to Lily's sink via pipewire-pulse.
    // XDG_RUNTIME_DIR: the systemd service starts without the user session's
    // runtime dir, and without it ffplay cannot find PipeWire at all.
    const env = {
      ...process.env,
      SDL_AUDIODRIVER: 'pulseaudio',
      PULSE_SINK: this.sinkName,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    };
    return new Promise((resolve, reject) => {
      const p = spawn(this.o.ffplayBin, ['-nodisp', '-autoexit', '-loglevel', 'error', file], { env });
      p.on('error', reject);
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffplay exit ${code}`)));
    });
  }

  // Wake tone + line joined into ONE file, so there is no gap (two separate
  // ffplay starts left a pause in which her motion could stop again).
  async _withWakeTone(file) {
    if (!(await this._ensureWakeTone())) return null;
    const out = path.join(os.tmpdir(), `lily-joined-${Date.now()}.wav`);
    const res = await run(this.o.ffmpegBin, ['-y', '-loglevel', 'error', '-i', this.wakeTonePath, '-i', file,
      // silenceremove trims any lead-in silence/breath from the line (Eleven v3
      // adds some) so the words always start right where the hum ends — her
      // movement keys off the hum and would otherwise run ahead of the voice.
      '-filter_complex', '[0:a]aresample=44100,aformat=channel_layouts=stereo[a];[1:a]silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.05,aresample=44100,aformat=channel_layouts=stereo[b];[a][b]concat=n=2:v=0:a=1[o]',
      '-map', '[o]', out], this.o.cmdTimeoutMs);
    return res.ok ? out : null;
  }

  // Play an existing audio file through Lily, wake tone joined in front.
  async playFile(file) {
    const joined = await this._withWakeTone(file);
    try { await this._playFile(joined || file); }
    finally { if (joined) try { fs.unlinkSync(joined); } catch (_) {} }
  }

  async playBuffer(audioBuffer) {
    const tmp = path.join(os.tmpdir(), `lily-line-${Date.now()}.audio`);
    fs.writeFileSync(tmp, audioBuffer);
    try {
      await this.playFile(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async disconnect() {
    if (!this.address) return;
    await this._bt(['disconnect', this.address]);
    this.sinkId = null;
    this.sinkName = null;
    this.o.log(`Disconnected ${this.address}`);
  }
}

module.exports = { create: (opts) => new LinuxLilyAudioRouter(opts) };
