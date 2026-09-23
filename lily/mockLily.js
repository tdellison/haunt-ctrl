// ─── Mock Lily — dev/test stand-in for the real BLE adapter ───────────────────
//
// Mirrors the reference project's SimulatedSkelly pattern: a fake BLE module
// with realistic state so the connection logic, safety interlock, and lantern
// mood-state logic can be built and unit-tested BEFORE real Lily hardware is
// unboxed and before the Linux box exists. The real noble-backed adapter must
// implement this exact same surface so the Witch Agent and Test tab never care
// which one they're driving.
//
// The safety interlock semantics here are the contract the real adapter must
// port EXACTLY (spec 2.1.8): movement is disarmed by default, setMovement
// rejects while disarmed, disarm forces movement to 'none', and any disconnect
// (clean or dropped) resets both.

'use strict';

const { MOVEMENT, LIGHT_MODE } = require('./protocol');

class MockLily {
  constructor(opts = {}) {
    this.log = opts.log || ((msg) => console.log(`[LILY mock] ${msg}`));
    this.connected = false;
    this.armed = false;
    this.movement = 'none';
    this.classicAudio = false;
    this.volume = 100;
    this.lantern = { r: 0, g: 0, b: 0, brightness: 0, mode: 'static' };
    this.firmware = 'mock-1.0';
  }

  async connect() {
    // Real adapter: scan -> connect -> VERIFY ae00 service present -> subscribe
    // ae02 -> queryVersion (missing reply is non-fatal) -> connected, DISARMED.
    this.connected = true;
    this.armed = false;
    this.movement = 'none';
    this.log('connected (movement disarmed by default)');
    return this.snapshot();
  }

  async armMovement(enabled) {
    this._requireConnected();
    this.armed = !!enabled;
    if (!enabled) this.movement = 'none'; // disarm also stops (sends setMovement(0))
    this.log(`movement ${enabled ? 'ARMED' : 'disarmed (and stopped)'}`);
    return this.snapshot();
  }

  async setMovement(action) {
    this._requireConnected();
    if (MOVEMENT[action] === undefined) throw new Error(`Unknown movement "${action}"`);
    if (!this.armed && action !== 'none') {
      throw new Error('Movement is disarmed — arm motors first');
    }
    this.movement = action;
    this.log(`movement -> ${action}`);
    return this.snapshot();
  }

  // Lantern is Lily's ONLY mood channel (her eyes are mechanical, no icon
  // display). Real adapter: three sequential GATT writes (brightness, mode,
  // RGB) with ~50ms sleeps between — firmware wants sequential, not batched.
  async setLantern(r, g, b, brightness, mode = 'static') {
    this._requireConnected();
    if (LIGHT_MODE[mode] === undefined) throw new Error(`Unknown lantern mode "${mode}"`);
    this.lantern = { r, g, b, brightness, mode };
    this.log(`lantern -> rgb(${r},${g},${b}) bri ${brightness} ${mode}`);
    return this.snapshot();
  }

  async setClassicAudio(enabled) {
    this._requireConnected();
    this.classicAudio = !!enabled;
    this.log(`classic BT audio receiver ${enabled ? 'armed' : 'disarmed'}`);
    return this.snapshot();
  }

  async setVolume(volume) {
    this._requireConnected();
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new Error(`Volume must be 0-100, got ${volume}`);
    }
    this.volume = volume;
    return this.snapshot();
  }

  async disconnect() {
    // Interlock: ANY disconnect (this one or an unexpected drop) forces
    // disarmed + 'none'. Never assume arm state survives a reconnect.
    this.connected = false;
    this.armed = false;
    this.movement = 'none';
    this.classicAudio = false;
    this.log('disconnected (interlock reset)');
    return this.snapshot();
  }

  snapshot() {
    return {
      driver: 'mock',
      connected: this.connected,
      armed: this.armed,
      movement: this.movement,
      classicAudio: this.classicAudio,
      volume: this.volume,
      lantern: { ...this.lantern },
      firmware: this.firmware,
    };
  }

  _requireConnected() {
    if (!this.connected) throw new Error('Not connected');
  }
}

module.exports = { MockLily };
