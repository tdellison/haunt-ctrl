// ─── Lily door greeter (work) — separate from the Halloween show ──────────────
//
// node greeter/server.js   → setup page at http://<this-computer>:3100
//
// Reuses the haunt's Lily code (../lily: Bluetooth movement, lantern, her
// speaker) but none of the show. Everything per-machine lives in this folder,
// gitignored: greeter-config.json, lily-config.json, secrets.json, cache/.

'use strict';

const fs = require('fs');
const path = require('path');

process.env.LILY_CONFIG = process.env.LILY_CONFIG || path.join(__dirname, 'lily-config.json');

const express = require('express');
const { createLily } = require('../lily');
const { createCamera, listCameras } = require('./camera');
const { createChime, listMics } = require('./chime');
const { createGreeter, playLocal } = require('./greeter');
const { createConverse } = require('./converse');

const PORT = Number(process.env.GREETER_PORT) || 3100;
const CONFIG_FILE = path.join(__dirname, 'greeter-config.json');
const SECRETS_FILE = path.join(__dirname, 'secrets.json');
const VOICES_FILE = path.join(__dirname, '..', 'voices.json');

// ── Log (ring buffer the page shows) ──
const logLines = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  console.log(`[GREETER] ${msg}`);
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
}

// ── Config ──
let lilyVoice = null;
try { lilyVoice = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8').replace(/^﻿/, '')).lily || null; } catch (_) {}

const DEFAULTS = {
  voiceId: lilyVoice,              // Lily's designed ElevenLabs voice
  lanternMood: 'calm',
  movement: 'all',
  builtinClip: 1,                  // used only when there is no ElevenLabs voice
  autoArm: true,                   // arm her motors at startup (she only moves while speaking)
  cooldownSec: 20,                 // one greeting per group walking in
  chimeWindowSec: 15,              // chime within this long of a camera greeting = same visitor
  chimeDelaySec: 3,                // after a chime, give the camera this long first
  hours: { start: '08:00', end: '18:00', weekdaysOnly: true },
  camera: {
    enabled: true,
    device: '',                    // blank = first webcam found
    fps: 5,
    box: { x0: 0.2, y0: 0.15, x1: 0.8, y1: 0.95 },   // detection area, fractions of the frame
    pixelDelta: 25,                // how much a pixel must change (0-255) to count
    minArea: 0.06,                 // share of the box that must change
    framesToTrigger: 2,
    quietFramesToRearm: 10,        // 2 s quiet at 5 fps before the next arrival counts
    adapt: 0.1,                    // background learning rate per frame (a still person fades in ~4 s)
  },
  chime: { enabled: true, source: '', tones: [], threshold: 0.4, minLevel: 0.01 },
  converse: {
    enabled: true,
    windowSec: 15,                 // how long she listens after greeting / after each reply
    alwaysListen: false,           // testing only: answer anything she hears
    about: '',                     // office notes she may pass on (who to ask for, sign-in, wifi...)
  },
  lines: {
    any: [
      'Hello there! Welcome in.',
      'Oh, a visitor! Come in, come in.',
      'Welcome! Someone will be right with you.',
      "Well, hello. Don't mind me, I just work here.",
    ],
    morning: ['Good morning! Welcome in.'],
    afternoon: ['Good afternoon! Welcome.'],
    evening: ['Good evening! Come on in.'],
  },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

let config = DEFAULTS;
try { config = merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (_) {}
const saveConfig = () => {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { log(`config save failed: ${e.message}`); }
};
const getConfig = () => config;

let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch (_) {}
const elevenKey = () => process.env.ELEVENLABS_API_KEY || secrets.elevenLabsApiKey || null;
const anthropicKey = () => process.env.ANTHROPIC_API_KEY || secrets.anthropicApiKey || null;

// ── Parts ──
const lily = createLily({ log: (m) => log(`Lily: ${m}`) });
let greeterRef = null;
const converse = createConverse({
  lily, log, getConfig, getApiKey: anthropicKey, getElevenKey: elevenKey, playLocal,
  isGreeting: () => !!(greeterRef && greeterRef.status().greeting),
});
const greeter = greeterRef = createGreeter({
  lily, log, getConfig, getElevenKey: elevenKey,
  onGreeted: (line) => converse.afterGreeting(line),
  inConversation: () => converse.inConversation(),
});
const camera = createCamera({ log, getConfig, onArrival: () => greeter.onCamera() });
const chime = createChime({
  log, getConfig,
  saveChime: (c) => { config.chime = { ...config.chime, ...c }; saveConfig(); },
  onChime: () => greeter.onChime(),
  onAudio: (pcm) => converse.onAudio(pcm),
});
// One mic stream feeds both the chime detector and the conversation.
const micWanted = () => !!(config.chime.enabled || config.converse.enabled);

// ── HTTP ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req.body || {}, req)) }); }
  catch (e) { log(`error: ${e.message}`); res.status(409).json({ ok: false, error: e.message }); }
};

app.get('/api/status', (req, res) => res.json({
  lily: lily.status(), camera: camera.status(), chime: chime.status(), greeter: greeter.status(),
  converse: converse.status(), keys: { elevenlabs: !!elevenKey(), anthropic: !!anthropicKey() }, log: logLines.slice(-60),
}));

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', route(async (body) => {
  const camBefore = JSON.stringify([config.camera.device, config.camera.fps, config.camera.enabled]);
  const micBefore = JSON.stringify([config.chime.source, micWanted()]);
  config = merge(config, body);
  // Lists are replaced whole, never merged.
  if (body.lines) config.lines = { ...config.lines, ...body.lines };
  saveConfig();
  if (JSON.stringify([config.camera.device, config.camera.fps, config.camera.enabled]) !== camBefore) {
    config.camera.enabled ? camera.restart() : camera.stop();
  }
  if (JSON.stringify([config.chime.source, micWanted()]) !== micBefore) {
    micWanted() ? chime.restart() : chime.stop();
  }
  converse.warmup();
  if (body.lines || body.voiceId) greeter.warm();
  return { config };
}));

app.post('/api/secrets', route(async ({ elevenLabsApiKey, anthropicApiKey }) => {
  if (typeof elevenLabsApiKey === 'string' && elevenLabsApiKey.trim()) secrets.elevenLabsApiKey = elevenLabsApiKey.trim();
  if (typeof anthropicApiKey === 'string' && anthropicApiKey.trim()) secrets.anthropicApiKey = anthropicApiKey.trim();
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  log('API key saved');
  greeter.warm();
  return { elevenlabs: !!elevenKey(), anthropic: !!anthropicKey() };
}));

// Lily
app.post('/api/lily/scan', route(async ({ seconds }) => ({ devices: await lily.scan(seconds || 8) })));
app.post('/api/lily/connect', route(async ({ address }) => {
  await lily.connect(address);
  if (config.autoArm) await lily.arm(true);
  return { lily: lily.status() };
}));
app.post('/api/lily/disconnect', route(async () => ({ lily: await lily.disconnect() })));
app.post('/api/lily/arm', route(async ({ on }) => ({ lily: await lily.arm(on) })));
app.post('/api/lily/mood', route(async ({ mood }) => ({ lily: await lily.setMood(mood) })));
app.post('/api/lily/volume', route(async ({ volume }) => ({ lily: await lily.volume(volume) })));
app.post('/api/lily/audio/connect', route(async ({ address, pair }) => ({ lily: await lily.audioConnect(address, { pair }) })));
app.post('/api/lily/audio/disconnect', route(async () => ({ lily: await lily.audioDisconnect() })));

// Camera
app.get('/api/camera/list', (req, res) => res.json(listCameras()));
app.get('/api/camera/snapshot.bmp', (req, res) => {
  const img = camera.snapshot();
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': 'image/bmp', 'Cache-Control': 'no-store' }).send(img);
});

// Mic / chime
app.get('/api/mic/list', async (req, res) => res.json(await listMics()));
app.post('/api/chime/learn', route(async ({ seconds }) => ({ learned: await chime.learn(Number(seconds) || 5) })));

// Greeting
app.post('/api/greet', route(async () => { await greeter.greet('test'); return { greeter: greeter.status() }; }));
app.post('/api/pause', route(async ({ minutes }) => { greeter.pause(Number(minutes) || 0); return { greeter: greeter.status() }; }));
app.post('/api/ask', route(async ({ text }) => {
  if (!String(text || '').trim()) throw new Error('text required');
  return { reply: await converse.ask(String(text).trim()) };
}));
app.post('/api/listen', route(async () => { converse.afterGreeting(null); return { converse: converse.status() }; }));
app.post('/api/warm', route(async () => ({ voiced: await greeter.warm() })));

app.listen(PORT, () => {
  log(`Door greeter on http://localhost:${PORT}`);
  startup();
});

// Bring everything up on boot so a power cut at work needs nobody to touch it.
async function startup() {
  if (config.camera.enabled) camera.start();
  if (micWanted()) chime.start();
  converse.warmup();
  greeter.warm().catch(() => {});
  let lc = {};
  try { lc = JSON.parse(fs.readFileSync(process.env.LILY_CONFIG, 'utf8')); } catch (_) {}
  if (lc.bleAddress) {
    try {
      await lily.connect();
      if (config.autoArm) await lily.arm(true);
      await lily.setMood(config.lanternMood || 'calm');
    } catch (e) { log(`Lily BLE not connected at startup: ${e.message}`); }
  }
  if (lc.audioAddress) {
    try { await lily.audioConnect(); } catch (e) { log(`Lily speaker not connected at startup: ${e.message}`); }
  }
}

function shutdown() {
  camera.stop(); chime.stop();
  Promise.race([lily.arm(false).catch(() => {}), new Promise(r => setTimeout(r, 1500))]).then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
