// ─── Lily protocol unit tests ─────────────────────────────────────────────────
// Run: node lily/protocol.test.js   (exits 0 silent-ish on pass, throws on fail)
// The spec orders CRC-8 + framing be proven in isolation BEFORE live BLE:
// a wrong bit-order/polynomial means every command silently fails on hardware.

'use strict';

const assert = require('assert');
const p = require('./protocol');

// CRC-8/MAXIM (Dallas) standard check value: "123456789" -> 0xA1.
assert.strictEqual(p.crc8(Buffer.from('123456789', 'ascii')), 0xA1, 'CRC-8/MAXIM check value');
assert.strictEqual(p.crc8([]), 0x00, 'CRC-8 of empty input');
assert.strictEqual(p.crc8([0x00]), 0x00, 'CRC-8 of single zero byte');

// Framing shape: 2-byte tag + 8-byte padded payload + 1-byte CRC = 11 bytes.
const move = p.cmdSetMovement('head_only');
assert.strictEqual(move.length, 11, 'framed command length');
assert.strictEqual(move[0], 0xAA, 'tag byte 0');
assert.strictEqual(move[1], 0xCA, 'movement tag byte 1');
assert.strictEqual(move[2], 0x01, 'payload starts with the movement byte (trailing-zero padding)');
assert.strictEqual(move[10], p.crc8(move.slice(0, 10)), 'CRC covers tag+payload');

// Enum names and raw values both accepted; junk rejected.
assert.deepStrictEqual(p.cmdSetMovement(255), p.cmdSetMovement('all'), 'name and byte agree');
assert.throws(() => p.cmdSetMovement('moonwalk'), /Unknown movement/, 'bad movement name rejected');
assert.throws(() => p.cmdSetMovement(3), /Unknown movement/, 'non-enum byte rejected (use cmdProbeMovement)');

// Tag/payload validation.
assert.throws(() => p.buildCommand('BBF9', '01'), /must be 4 hex chars starting with AA/, 'non-AA tag rejected');
assert.throws(() => p.buildCommand('AAF9', '012'), /whole bytes/, 'odd-length payload rejected');

// Classic audio, volume bounds.
assert.strictEqual(p.cmdSetClassicAudio(true)[2], 0x01, 'classic audio on byte');
assert.strictEqual(p.cmdSetClassicAudio(false)[2], 0x00, 'classic audio off byte');
assert.throws(() => p.cmdSetVolume(101), /0-100/, 'volume >100 rejected');
assert.strictEqual(p.cmdSetVolume(100)[2], 0x64, 'volume 100 -> 0x64');

// Lighting: three separate commands (brightness / mode / RGB), head channel = 1.
const bri = p.cmdSetLightBrightness(p.LIGHT_CHANNEL.head, 200);
assert.strictEqual(bri[2], 0x01, 'head channel byte');
assert.strictEqual(bri[3], 0xC8, 'brightness byte');
const rgb = p.cmdSetLightRGB(0, 255, 128, 0, 0);
assert.deepStrictEqual([...rgb.slice(2, 7)], [0x00, 0xFF, 0x80, 0x00, 0x00], 'RGB payload order');
assert.strictEqual(p.cmdSetLightMode(1, 'strobe')[3], 0x02, 'strobe mode byte');
assert.throws(() => p.cmdSetLightMode(1, 'disco'), /Unknown light mode/, 'bad mode rejected');

// Media file: 2-byte big-endian serial + enable byte.
const media = p.cmdPlayMediaFile(0x0102, true);
assert.deepStrictEqual([...media.slice(2, 5)], [0x01, 0x02, 0x01], 'media serial framing');

// Eye icons: valid protocol, explicitly N/A for Lily.
assert.strictEqual(p.cmdSetEyeIcon(12)[2], 0x0C, 'skull icon byte (Ultra Skelly only)');
assert.throws(() => p.cmdSetEyeIcon(19), /1-18/, 'icon index bounds');

// Probe values: 0x08..0xF8 step 8, framed like movement commands.
const probes = p.probeMovementValues();
assert.strictEqual(probes[0], 0x08, 'probe range start');
assert.strictEqual(probes[probes.length - 1], 0xF8, 'probe range end');
assert.strictEqual(probes.length, 31, 'probe count');
assert.strictEqual(p.cmdProbeMovement(0x08)[1], 0xCA, 'probe uses the movement tag');

console.log('lily/protocol.test.js: all assertions passed');
