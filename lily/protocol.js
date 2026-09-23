// ─── Lily BLE protocol — constants, CRC-8, command framing ────────────────────
//
// Ported conceptually from TheDadTech/UltraSkellyAdvanced (ble_protocol.py) —
// no code copied verbatim. Lily (Lethal Lily) shares the SVI electronics/BLE
// protocol family with Ultra Skelly: same service/characteristic UUIDs, same
// command framing and CRC-8. Hardware BEHAVIOR assumptions do NOT carry over
// (see notes on eyes and movement below) — the bytes should, the physics may not.
//
// Pure functions only: no BLE, no I/O. This file works identically on the
// Windows laptop and the Linux OptiPlex, and is unit-tested in isolation
// (lily/protocol.test.js) BEFORE any live BLE work, exactly as the spec orders:
// a wrong bit-order or polynomial here means every command silently fails.

'use strict';

const SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb';
const WRITE_UUID   = '0000ae01-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID  = '0000ae02-0000-1000-8000-00805f9b34fb';

// Command tags (2 bytes, always AAxx).
const TAGS = {
  EYE_ICON:         'AAF9', // NOT applicable to Lily — her eyes are mechanical (see below)
  MOVEMENT:         'AACA',
  CLASSIC_AUDIO:    'AAFD', // arms/disarms the prop's Classic BT audio receiver
  SET_VOLUME:       'AAFA',
  QUERY_VOLUME:     'AAE5',
  QUERY_VERSION:    'AAEE', // optional/non-fatal on connect
  LIGHT_BRIGHTNESS: 'AAF3',
  LIGHT_RGB:        'AAF4',
  LIGHT_MODE:       'AAF2',
  PLAY_MEDIA:       'AAC6', // stored on-prop sound files, 2-byte serial
};

// Movement is a small fixed enum (a coarse bitfield), NOT freeform servo
// positions. Lily's real servo layout (eyes / mouth / head / left arm+elbow /
// left hand+wrist — right arm presumed static) is more granular than these
// Ultra Skelly names; whether her firmware maps them onto these same values or
// uses extra ones is a real-hardware question. probeMovementValues() below
// exists to map that out systematically — do not assume the names apply as-is.
const MOVEMENT = {
  none: 0,
  head_only: 1,
  arms_only: 2,
  torso_only: 4,
  head_and_torso: 5,
  torso_and_arms: 6,
  all: 255,
  // raw 7 was seen validated in the reference protocol but has no name —
  // possible undocumented combo, not required for launch.
};

const LIGHT_CHANNEL = { torso: 0, head: 1 };
const LIGHT_MODE    = { static: 1, strobe: 2, pulse: 3 };

// Eye icon table — kept for protocol completeness only. Lily's eyes are
// PHYSICAL (pan/tilt + blink), not a digital icon display, so setEyeIcon()
// does not apply to her; mood/reaction is conveyed entirely via the lantern.
const EYE_ICONS = {
  1: 'normal', 2: 'hazel', 3: 'green', 4: 'brown', 5: 'angry',
  6: 'gray', 7: 'squint', 8: 'orange_cat', 9: 'spiral', 10: 'fire',
  11: 'star', 12: 'skull', 13: 'fireworks', 14: 'american_flag',
  15: 'hearts', 16: 'clover', 17: 'snowflake', 18: 'confetti',
};

// CRC-8 Dallas/Maxim: polynomial 0x8C, LSB-first. Check value: crc8 over the
// ASCII bytes of "123456789" must equal 0xA1 (verified in protocol.test.js).
function crc8(bytes) {
  let result = 0;
  for (const b of bytes) {
    result ^= b;
    for (let i = 0; i < 8; i++) {
      result = (result & 1) ? ((result >> 1) ^ 0x8C) : (result >> 1);
    }
  }
  return result & 0xFF;
}

// Frame: 2-byte tag + payload padded to minimumPayloadBytes with TRAILING
// zeros + 1-byte CRC-8 over everything before it. (The spec text says
// "trailing zeros" in one place and "right-justified" in another; trailing is
// implemented here — VERIFY against a known-good captured command on real
// hardware before trusting it, and flip padStart/padEnd if the prop NAKs.)
function buildCommand(tag, payloadHex = '', minimumPayloadBytes = 8) {
  if (!/^AA[0-9A-F]{2}$/i.test(tag)) {
    throw new Error(`Bad command tag "${tag}" — must be 4 hex chars starting with AA`);
  }
  if (!/^([0-9A-F]{2})*$/i.test(payloadHex)) {
    throw new Error(`Bad payload hex "${payloadHex}" — must be whole bytes`);
  }
  const padded = payloadHex.toUpperCase().padEnd(minimumPayloadBytes * 2, '0');
  const body = Buffer.from(tag + padded, 'hex');
  return Buffer.concat([body, Buffer.from([crc8(body)])]);
}

function hexByte(v, name, min = 0, max = 255) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} must be an integer ${min}-${max}, got ${v}`);
  }
  return v.toString(16).toUpperCase().padStart(2, '0');
}

// ─── Command builders ─────────────────────────────────────────────────────────
// Payload byte layouts below follow the reference project's ordering; each is
// a needs-verification-on-real-Lily item until acknowledged by the prop.

function cmdSetMovement(action) {
  const v = typeof action === 'string' ? MOVEMENT[action] : action;
  if (v === undefined || !Object.values(MOVEMENT).includes(v)) {
    throw new Error(`Unknown movement "${action}" — use one of ${Object.keys(MOVEMENT).join('/')}`);
  }
  return buildCommand(TAGS.MOVEMENT, hexByte(v, 'movement'));
}

function cmdSetClassicAudio(enabled) {
  return buildCommand(TAGS.CLASSIC_AUDIO, enabled ? '01' : '00');
}

function cmdSetVolume(volume) {
  return buildCommand(TAGS.SET_VOLUME, hexByte(volume, 'volume', 0, 100));
}

function cmdQueryVolume()  { return buildCommand(TAGS.QUERY_VOLUME); }
function cmdQueryVersion() { return buildCommand(TAGS.QUERY_VERSION); }

function cmdSetLightBrightness(channel, brightness) {
  return buildCommand(TAGS.LIGHT_BRIGHTNESS,
    hexByte(channel, 'channel', 0, 1) + hexByte(brightness, 'brightness'));
}

function cmdSetLightRGB(channel, r, g, b, cycle = 0) {
  return buildCommand(TAGS.LIGHT_RGB,
    hexByte(channel, 'channel', 0, 1) + hexByte(r, 'r') + hexByte(g, 'g') +
    hexByte(b, 'b') + hexByte(cycle, 'cycle', 0, 1));
}

function cmdSetLightMode(channel, mode) {
  const m = typeof mode === 'string' ? LIGHT_MODE[mode] : mode;
  if (m === undefined || m < 1 || m > 3) {
    throw new Error(`Unknown light mode "${mode}" — use static/strobe/pulse or 1-3`);
  }
  return buildCommand(TAGS.LIGHT_MODE, hexByte(channel, 'channel', 0, 1) + hexByte(m, 'mode'));
}

function cmdPlayMediaFile(serial, enabled = true) {
  if (!Number.isInteger(serial) || serial < 0 || serial > 0xFFFF) {
    throw new Error(`Media serial must be 0-65535, got ${serial}`);
  }
  const hi = (serial >> 8) & 0xFF, lo = serial & 0xFF;
  return buildCommand(TAGS.PLAY_MEDIA,
    hexByte(hi, 'serial hi') + hexByte(lo, 'serial lo') + (enabled ? '01' : '00'));
}

// Kept for completeness — do not call for Lily (no digital eye display).
function cmdSetEyeIcon(index) {
  if (!EYE_ICONS[index]) throw new Error(`Eye icon index must be 1-18, got ${index}`);
  return buildCommand(TAGS.EYE_ICON, hexByte(index, 'icon'));
}

// The unused-bitfield probe values (0x08-0xF8, step 8) for mapping Lily's five
// real servo points onto AACA values on real hardware. Feed each through
// cmdSetMovement-style framing (buildCommand directly — these bytes are NOT in
// the MOVEMENT enum on purpose) and note which physical points move.
function probeMovementValues() {
  const vals = [];
  for (let v = 0x08; v <= 0xF8; v += 8) vals.push(v);
  return vals;
}

function cmdProbeMovement(rawByte) {
  return buildCommand(TAGS.MOVEMENT, hexByte(rawByte, 'probe byte'));
}

module.exports = {
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID,
  TAGS, MOVEMENT, LIGHT_CHANNEL, LIGHT_MODE, EYE_ICONS,
  crc8, buildCommand,
  cmdSetMovement, cmdSetClassicAudio, cmdSetVolume, cmdQueryVolume, cmdQueryVersion,
  cmdSetLightBrightness, cmdSetLightRGB, cmdSetLightMode, cmdPlayMediaFile, cmdSetEyeIcon,
  probeMovementValues, cmdProbeMovement,
};
