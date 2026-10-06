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

// Lantern mood states (spec 2.1.5). VERIFIED ON REAL LILY 2026-10-04: colour
// works on light channel 0xFF only (captured from the official app — channels
// 0-3 are ignored). Effects (mode): 1 = flame, 2 = blinking, 3 = downward sweep.
// Colours are the owner's picks from the app, captured byte-for-byte:
//   calm = candle orange flame, wary = spooky purple sweep, ward = white blinking.
// All three stay clear of Evelina's spell palette.
const LANTERN_MOODS = {
  calm: { r: 0xFF, g: 0x3C, b: 0x00, brightness: 200, mode: 'static' }, // deep orange, flame (the app's FF8223 looked white on her LEDs)
  wary: { r: 0xCE, g: 0x1E, b: 0xFF, brightness: 200, mode: 'pulse'  }, // purple, downward sweep
  ward: { r: 0xE7, g: 0xFF, b: 0xFC, brightness: 255, mode: 'strobe' }, // white, blinking
  off:  { r: 0,    g: 0,    b: 0,    brightness: 0,   mode: 'static' },
};
// Ward = a sharp flare, held a beat, then it settles to a steady glow while
// she delivers her protective line (it reads as a thrown ward, not a mood).
const WARD_FLARE_MS = 2500;
const WARD_SETTLE = { r: 0xE7, g: 0xFF, b: 0xFC, brightness: 200, mode: 'static' };   // white, steady flame

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
  if (cfg.wakeTone) audio.setWakeTone(cfg.wakeTone);
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
        // Her speaker only appears after live mode, and not instantly.
        if (ble.connected) {
          await ble.setClassicAudio(true).catch(e => log(`classic-audio arm failed: ${e.message}`));
          await new Promise(r => setTimeout(r, 2000));
        }
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
    // Tune the pre-roll hum that gets her moving before the first word.
    setWakeTone(t) { cfg.wakeTone = audio.setWakeTone(t); save(); return cfg.wakeTone; },
    // Plays ONLY on her own speaker: if it has dropped, reconnect first; if that
    // fails, throw — never let the sound fall through to the yard speakers.
    async playFile(file) {
      if (!audioState.connected) throw new Error('Lily speaker not connected');
      if (!(await audio.sinkPresent())) {
        log('speaker dropped — reconnecting before she speaks');
        await reconnectSpeaker();
      }
      await audio.playFile(file);
    },
  };

  // Speaker watchdog: her Classic BT speaker can drop on its own. While it is
  // supposed to be connected, check every 15 s and reconnect (re-sending live
  // mode, which her speaker needs before it will accept a connection).
  let reconnecting = null;
  function reconnectSpeaker() {
    if (!reconnecting) {
      audioState.routed = false;
      reconnecting = api.audioConnect()
        .then(() => { log('speaker reconnected'); })
        .catch((e) => { log(`speaker reconnect failed: ${e.message}`); throw e; })
        .finally(() => { reconnecting = null; });
    }
    return reconnecting;
  }
  if (audio.isReal) {
    setInterval(async () => {
      if (!audioState.connected || reconnecting) return;
      try { if (!(await audio.sinkPresent())) { log('speaker dropped — watchdog reconnecting'); await reconnectSpeaker(); } }
      catch (_) {}
    }, 15000);
  }
  return api;
}

module.exports = { createLily, LANTERN_MOODS };
