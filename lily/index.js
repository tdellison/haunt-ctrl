// ─── Lily controller — the ONE thing server.js imports for Lily ───────────────
//
// Owns her BLE driver (movement / lantern / safety interlock) and her Classic
// BT audio router, plus the per-machine config that has to survive restarts
// (her addresses, the enabled flag). Every method is safe to call when she is
// absent: errors are thrown to the caller (a route answers 409/502), nothing
// here ever throws into a show beat.
//
// Driver choice: the real BlueZ driver on Linux, the mock on Windows or when
// LILY_DRIVER=mock (dry-running the Test tab without the prop).

'use strict';

const fs = require('fs');
const path = require('path');
const { MockLily } = require('./mockLily');
const { createLilyAudioRouter } = require('./audioRouter');
const { MOVEMENT, probeMovementValues } = require('./protocol');

// Lantern mood states (spec 2.1.5). VERIFIED ON REAL LILY 2026-10-04: her
// lantern is GREEN ONLY — the RGB command (AAF4) changes nothing on any channel,
// in or out of live mode. Only the MODE (AAF2) works, and on Lily the modes are
// effects, not Ultra Skelly's names: 1 = flame, 2 = blinking, 3 = light moving
// downward (0 and 4 = no change). So the moods are carried by the effect:
// calm = flame, wary = downward sweep, ward = blinking. The RGB values below are
// kept in case a colour command turns up, but they do nothing today.
const LANTERN_MOODS = {
  calm: { r: 255, g: 120, b: 30,  brightness: 110, mode: 'static' }, // soft candle
  wary: { r: 0,   g: 210, b: 200, brightness: 170, mode: 'pulse'  }, // uneasy cyan
  ward: { r: 255, g: 235, b: 180, brightness: 255, mode: 'strobe' }, // warm-white flare
  off:  { r: 0,   g: 0,   b: 0,   brightness: 0,   mode: 'static' },
};
// Ward = a sharp flare, held a beat, then it settles to a steady glow while
// she delivers her protective line (it reads as a thrown ward, not a mood).
const WARD_FLARE_MS = 2500;
const WARD_SETTLE = { r: 255, g: 235, b: 180, brightness: 200, mode: 'static' };

const CONFIG_FILE = path.join(__dirname, '..', 'lily-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

function createLily({ log = console.log, onChange = () => {} } = {}) {
  const cfg = { enabled: false, bleAddress: null, audioAddress: null, ...loadConfig() };
  const save = () => {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { log(`config save failed: ${e.message}`); }
  };

  const useMock = process.env.LILY_DRIVER === 'mock' || process.platform !== 'linux';
  const driverOpts = { log: (m) => log(m), onStatus: () => onChange(), address: cfg.bleAddress };
  const ble = useMock ? new MockLily(driverOpts) : new (require('./bleLily').BleLily)(driverOpts);
  const audio = createLilyAudioRouter({ log: (m) => log(`audio: ${m}`), deviceAddress: cfg.audioAddress });
  const audioState = { connected: false, routed: false, lastError: null };
  let wardTimer = null;
  let mood = null;

  const changed = (x) => { onChange(); return x; };

  const api = {
    get enabled() { return cfg.enabled; },

    setEnabled(on) { cfg.enabled = !!on; save(); return changed(api.status()); },

    status() {
      return {
        enabled: cfg.enabled,
        ...ble.snapshot(),
        mood,
        audio: { address: cfg.audioAddress, real: !!audio.isReal, ...audioState },
        moods: Object.keys(LANTERN_MOODS),
        movements: Object.keys(MOVEMENT),
      };
    },

    scan: (seconds) => ble.scan(seconds),

    async connect(address) {
      if (address) { cfg.bleAddress = address; save(); }
      await ble.connect(address || cfg.bleAddress);
      return changed(api.status());
    },
    async disconnect() { clearTimeout(wardTimer); await ble.disconnect(); mood = null; return changed(api.status()); },

    async arm(on) { await ble.armMovement(!!on); return changed(api.status()); },
    async move(action) { await ble.setMovement(action); return changed(api.status()); },
    async probe(raw) { await ble.probeMovement(raw); return changed(api.status()); },
    probeValues: probeMovementValues,

    async lantern({ r, g, b, brightness, mode }) {
      clearTimeout(wardTimer);
      await ble.setLantern(r, g, b, brightness, mode);
      mood = 'custom';
      return changed(api.status());
    },

    async setMood(name) {
      const m = LANTERN_MOODS[name];
      if (!m) throw new Error(`Unknown mood "${name}" — use ${Object.keys(LANTERN_MOODS).join('/')}`);
      clearTimeout(wardTimer);
      await ble.setLantern(m.r, m.g, m.b, m.brightness, m.mode);
      mood = name;
      if (name === 'ward') {
        wardTimer = setTimeout(async () => {
          try { await ble.setLantern(WARD_SETTLE.r, WARD_SETTLE.g, WARD_SETTLE.b, WARD_SETTLE.brightness, WARD_SETTLE.mode); onChange(); }
          catch (e) { log(`ward settle failed: ${e.message}`); }
        }, WARD_FLARE_MS);
      }
      return changed(api.status());
    },

    async volume(v) { await ble.setVolume(v); return changed(api.status()); },
    async classicAudio(on) { await ble.setClassicAudio(!!on); return changed(api.status()); },
    async playMedia(serial) { await ble.playMedia(serial); return changed(api.status()); },

    // Classic BT speaker: arm her receiver over BLE (if connected), then
    // pair/trust, connect, wait for the sink, and point HER playback at it.
    async audioConnect(address, { pair = false } = {}) {
      if (address) { cfg.audioAddress = address; save(); }
      if (!cfg.audioAddress) throw new Error('No Lily audio address — scan and pick her speaker first');
      audioState.lastError = null;
      try {
        if (ble.connected) await ble.setClassicAudio(true).catch(e => log(`classic-audio arm failed: ${e.message}`));
        if (pair) await audio.pair(cfg.audioAddress);
        await audio.connect(cfg.audioAddress);
        audioState.connected = true;
        await audio.routeAudioOutput();
        audioState.routed = true;
      } catch (e) {
        audioState.lastError = e.message;
        onChange();
        throw e;
      }
      return changed(api.status());
    },
    async audioDisconnect() {
      await audio.disconnect();
      audioState.connected = false;
      audioState.routed = false;
      return changed(api.status());
    },
    async playFile(file) {
      if (!audioState.routed) throw new Error('Lily speaker not connected');
      await audio.playFile(file);
    },
  };
  return api;
}

module.exports = { createLily, LANTERN_MOODS };
