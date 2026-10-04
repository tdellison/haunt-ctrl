// ─── Lily BLE adapter — the REAL one (BlueZ over D-Bus via node-ble) ─────────
//
// Same surface as mockLily.js, so the routes and the Test tab never care which
// one they're driving. Implements spec 2.1.7 (connection sequence), 2.1.8
// (safety interlock — ported exactly) and 2.1.9 (auto-reconnect).
//
// Why node-ble and not @abandonware/noble: noble on Linux talks to the radio
// through a raw HCI socket, which needs root/cap_net_raw AND fights bluetoothd
// for the adapter — but bluetoothd has to stay up because Lily's Classic BT
// AUDIO (audioRouter.linux.js) goes through BlueZ. node-ble drives the same
// BlueZ daemon over D-Bus, so BLE and Classic audio share one owner of the
// radio, and it needs no special permissions. Linux-only: on the Windows
// laptop lily/index.js falls back to the mock.
//
// Every byte on the wire comes from lily/protocol.js — this file only moves
// frames, it never builds them.

'use strict';

const P = require('./protocol');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Names Lily's BLE side might advertise under. The reference Ultra Skelly
// advertised as 'Skelly'; Lily's real name is a needs-verification item, so the
// scan ALSO matches any device advertising the ae00 service UUID.
const NAME_HINT = /lily|skelly|svi|home ?depot/i;

class BleLily {
  constructor(opts = {}) {
    this.log = opts.log || ((msg) => console.log(`[LILY] ${msg}`));
    this.onStatus = opts.onStatus || (() => {});
    this.address = opts.address || null;
    this.connected = false;
    this.connecting = false;
    this.armed = false;
    this.movement = 'none';
    this.classicAudio = false;
    this.volume = null;
    this.lantern = { r: 0, g: 0, b: 0, brightness: 0, mode: 'static' };
    this.firmware = null;
    this.lastNotify = null;
    this.lastError = null;
    this.wantConnected = false;   // auto-reconnect only while this is true
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._bt = null;
    this._device = null;
    this._write = null;
    this._notify = null;
    this._writeType = 'request';
    this._writeChain = Promise.resolve();
  }

  async _adapter() {
    if (!this._bt) {
      const { createBluetooth } = require('node-ble');
      this._bt = createBluetooth();
    }
    const adapter = await this._bt.bluetooth.defaultAdapter();
    if (!await adapter.isPowered()) throw new Error('Bluetooth adapter is powered off');
    return adapter;
  }

  // Discovery window, then list what was seen. Lily candidates first: anything
  // advertising the ae00 service or with a name that looks like her.
  async scan(seconds = 10) {
    const adapter = await this._adapter();
    if (!await adapter.isDiscovering()) await adapter.startDiscovery();
    await sleep(seconds * 1000);
    try { await adapter.stopDiscovery(); } catch (_) {}
    const found = [];
    for (const addr of await adapter.devices()) {
      try {
        const dev = await adapter.getDevice(addr);
        const name = await dev.getName().catch(() => dev.getAlias().catch(() => ''));
        const rssi = await dev.getRSSI().catch(() => null);
        const uuids = await dev.helper.prop('UUIDs').catch(() => []) || [];
        const hasService = uuids.some(u => u.toLowerCase() === P.SERVICE_UUID);
        found.push({ address: addr, name, rssi, likelyLily: hasService || NAME_HINT.test(name || '') });
      } catch (_) {}
    }
    found.sort((a, b) => (b.likelyLily - a.likelyLily) || ((b.rssi ?? -999) - (a.rssi ?? -999)));
    return found;
  }

  // Spec 2.1.7, in order: find -> connect -> VERIFY ae00 -> subscribe ae02 ->
  // queryVersion (a missing reply is NON-fatal) -> connected, DISARMED.
  async connect(address) {
    if (address) this.address = address;
    if (!this.address) throw new Error('No Lily address — scan and pick her first');
    this.wantConnected = true;
    clearTimeout(this._reconnectTimer);
    try { await this._connectOnce(); }
    catch (e) { this.lastError = e.message; this.wantConnected = false; throw e; }
    return this.snapshot();
  }

  async _connectOnce() {
    if (this.connecting) throw new Error('Connect already in progress');
    this.connecting = true;
    try {
      const adapter = await this._adapter();
      if (!await adapter.isDiscovering()) await adapter.startDiscovery().catch(() => {});
      let dev;
      try { dev = await adapter.waitDevice(this.address, 20000); }
      finally { await adapter.stopDiscovery().catch(() => {}); }

      this.log(`Connecting to ${this.address}…`);
      await dev.connect();
      this._device = dev;

      const gatt = await dev.gatt();
      let service;
      try { service = await gatt.getPrimaryService(P.SERVICE_UUID); }
      catch (_) {
        // Guard against pairing with some unrelated BLE device.
        await dev.disconnect().catch(() => {});
        throw new Error(`${this.address} has no ae00 service — not Lily`);
      }
      this._write = await service.getCharacteristic(P.WRITE_UUID);
      this._notify = await service.getCharacteristic(P.NOTIFY_UUID);
      const flags = await this._write.getFlags().catch(() => []);
      this._writeType = flags.includes('write') ? 'request' : 'command';

      this._notify.on('valuechanged', (buf) => this._onNotify(buf));
      await this._notify.startNotifications();

      dev.once('disconnect', () => this._onDrop());

      this.connected = true;
      this.armed = false;
      this.movement = 'none';
      this.reconnectAttempts = 0;
      this.lastError = null;

      this.firmware = null;
      const version = this._awaitNotify('AAEE', 2000);
      await this._send(P.cmdQueryVersion());
      const v = await version;
      if (v) this.firmware = v.toString('hex').toUpperCase();
      else this.log('No version reply (non-fatal)');

      this.log(`Connected${this.firmware ? ` (fw reply ${this.firmware})` : ''} — movement DISARMED`);
      this.onStatus('connected');
    } finally {
      this.connecting = false;
    }
  }

  _onNotify(buf) {
    this.lastNotify = { hex: buf.toString('hex').toUpperCase(), at: Date.now() };
    for (const w of this._notifyWaiters || []) w(buf);
  }

  // Resolve with the first notification whose hex starts with a tag-ish
  // prefix (the prop's reply framing is unverified, so accept ANY reply
  // within the window rather than guessing a prefix too strictly).
  _awaitNotify(_prefix, ms) {
    return new Promise((resolve) => {
      this._notifyWaiters = this._notifyWaiters || [];
      const done = (buf) => {
        clearTimeout(t);
        this._notifyWaiters = this._notifyWaiters.filter(w => w !== done);
        resolve(buf);
      };
      const t = setTimeout(() => done(null), ms);
      this._notifyWaiters.push(done);
    });
  }

  // Interlock (2.1.8): ANY drop forces disarmed + 'none' immediately. Then
  // auto-reconnect (2.1.9) on a capped backoff — never restoring arm state.
  _onDrop() {
    const wasConnected = this.connected;
    this.connected = false;
    this.armed = false;
    this.movement = 'none';
    this.classicAudio = false;
    this._write = null;
    this._notify = null;
    if (wasConnected) {
      this.log('Disconnected — interlock reset (disarmed, movement none)');
      this.onStatus('disconnected');
    }
    if (this.wantConnected) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(5000 * 2 ** Math.min(this.reconnectAttempts, 3), 60000);
    this.reconnectAttempts++;
    this.log(`Reconnect attempt ${this.reconnectAttempts} in ${delay / 1000}s`);
    this._reconnectTimer = setTimeout(async () => {
      if (!this.wantConnected || this.connected) return;
      try { await this._connectOnce(); }
      catch (e) {
        this.lastError = e.message;
        this.log(`Reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  // Writes are serialised: the firmware expects sequential commands.
  _send(frame) {
    const job = this._writeChain.then(async () => {
      if (!this.connected && !this._write) throw new Error('Not connected');
      if (!this._write) throw new Error('Not connected');
      await this._write.writeValue(frame, { type: this._writeType });
    });
    this._writeChain = job.catch(() => {});
    return job;
  }

  _requireConnected() {
    if (!this.connected) throw new Error('Lily is not connected');
  }

  async armMovement(enabled) {
    this._requireConnected();
    if (!enabled) {
      // Disarm ALSO stops: send movement 0 before dropping the arm flag.
      await this._send(P.cmdSetMovement('none'));
      this.movement = 'none';
    }
    this.armed = !!enabled;
    this.log(`Movement ${enabled ? 'ARMED' : 'disarmed (and stopped)'}`);
    return this.snapshot();
  }

  async setMovement(action) {
    this._requireConnected();
    if (P.MOVEMENT[action] === undefined) throw new Error(`Unknown movement "${action}"`);
    if (!this.armed && action !== 'none') throw new Error('Movement is disarmed — arm motors first');
    await this._send(P.cmdSetMovement(action));
    this.movement = action;
    return this.snapshot();
  }

  // Raw AACA probe for mapping her 5 servo points (spec 2.1.6). Same interlock.
  async probeMovement(rawByte) {
    this._requireConnected();
    if (!this.armed && rawByte !== 0) throw new Error('Movement is disarmed — arm motors first');
    await this._send(P.cmdProbeMovement(rawByte));
    this.movement = rawByte === 0 ? 'none' : `probe:0x${rawByte.toString(16).toUpperCase()}`;
    return this.snapshot();
  }

  // Lantern = Lily's ONLY mood channel. Three sequential writes (brightness,
  // mode, RGB), ~50ms apart — the firmware wants them one at a time.
  async setLantern(r, g, b, brightness, mode = 'static', channel = P.LIGHT_CHANNEL.all) {
    this._requireConnected();
    if (P.LIGHT_MODE[mode] === undefined) throw new Error(`Unknown lantern mode "${mode}"`);
    await this._send(P.cmdSetLightBrightness(channel, brightness));
    await sleep(50);
    await this._send(P.cmdSetLightMode(channel, mode));
    await sleep(50);
    await this._send(P.cmdSetLightRGB(channel, r, g, b, 0));
    this.lantern = { r, g, b, brightness, mode };
    return this.snapshot();
  }

  async setClassicAudio(enabled) {
    this._requireConnected();
    await this._send(P.cmdSetClassicAudio(!!enabled));
    this.classicAudio = !!enabled;
    return this.snapshot();
  }

  async setVolume(volume) {
    this._requireConnected();
    await this._send(P.cmdSetVolume(volume));
    this.volume = volume;
    return this.snapshot();
  }

  async playMedia(serial) {
    this._requireConnected();
    await this._send(P.cmdPlayMediaFile(serial, true));
    return this.snapshot();
  }

  async disconnect() {
    this.wantConnected = false;
    clearTimeout(this._reconnectTimer);
    if (this.connected) {
      try { await this._send(P.cmdSetMovement('none')); } catch (_) {}
    }
    const dev = this._device;
    this._onDrop();
    if (dev) await dev.disconnect().catch(() => {});
    this._device = null;
    return this.snapshot();
  }

  snapshot() {
    return {
      driver: 'ble',
      address: this.address,
      connected: this.connected,
      connecting: this.connecting,
      armed: this.armed,
      movement: this.movement,
      classicAudio: this.classicAudio,
      volume: this.volume,
      lantern: { ...this.lantern },
      firmware: this.firmware,
      lastNotify: this.lastNotify,
      lastError: this.lastError,
      reconnecting: this.wantConnected && !this.connected,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

module.exports = { BleLily };
