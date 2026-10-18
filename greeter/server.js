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
const { execFile } = require('child_process');
const { createLily } = require('../lily');
const { createCamera, listCameras } = require('./camera');
const { createChime, listMics } = require('./chime');
const { createGreeter, playLocal } = require('./greeter');
const { createConverse } = require('./converse');
const { createFaces } = require('./faces');
const { createOutfit } = require('./outfit');

const PORT = Number(process.env.GREETER_PORT) || 3100;
const CONFIG_FILE = path.join(__dirname, 'greeter-config.json');
const SECRETS_FILE = path.join(__dirname, 'secrets.json');

// ── Log (ring buffer the page shows) ──
const logLines = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  console.log(`[GREETER] ${msg}`);
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
}

// ── Config ──

// Her door-greeter voice (Todd's pick, 2026-10-17) — the haunt keeps voices.json's.
const GREETER_VOICE = '6xNonY5CNANKZ87uLcCK';

const DEFAULTS = {
  voiceId: GREETER_VOICE,          // Lily's greeter-only ElevenLabs voice
  lanternMood: 'calm',
  movement: 'all',
  builtinClip: 1,                  // used only when there is no ElevenLabs voice
  autoArm: true,                   // arm her motors at startup (she only moves while speaking)
  cooldownSec: 20,                 // one greeting per group walking in
  chimeWindowSec: 15,              // chime within this long of a camera greeting = same visitor
  chimeDelaySec: 3,                // after a chime, give the camera this long first
  // No greeting hours: the PC is switched on at work and off when Todd leaves,
  // so she greets whenever she's running. (Hours can still be set on the page.)
  hours: { start: '', end: '', weekdaysOnly: false },
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
  // Team recognition — on; does nothing until team photos are added.
  faces: {
    enabled: true,
    requireFace: true,             // no face seen = someone walking out: stay quiet
    threshold: 0.4,                // how alike a face must be to a teammate's photos (0-1)
    minFacePx: 60,                 // ignore faces smaller than this (far side of the room)
    lookSec: 2,                    // how long she looks before deciding
    teamRemarkEveryMin: 60,        // at most one remark per teammate per this many minutes
  },
  // Outfit remarks — OFF by default: sends one camera picture to Claude.
  outfit: { enabled: false, chance: 0.35 },
  teamLines: [
    "Oh, it's just you, {name}. You may go now.",
    "{name}! Explain the cloud to me again. I keep looking up and seeing nothing.",
    "Back again, {name}? Did you fix the thing? I certainly didn't.",
    "{name}. I tried rebooting myself while you were gone. It didn't take. [cackles]",
  ],
  converse: {
    enabled: true,
    windowSec: 15,                 // how long she listens after greeting / after each reply
    alwaysListen: false,           // testing only: answer anything she hears
    about: '',                     // office notes she may pass on (who to ask for, sign-in, wifi...)
  },
  // Lily as a 300-year-old witch the help desk talked into greeting (2026-10-18).
  lines: {
    any: [
      "Welcome to the help desk! I've been here three hundred years and I still don't know what a router is.",
      "Ah, a visitor! State your problem. I'll nod wisely while the real wizards fix it.",
      "Hello, hello! The tech people are just behind me. I mostly guard the door.",
      "[cackles] Welcome! Have you tried turning it off and on again? It's the only spell they taught me.",
      "Oh good, a mortal. Someone will be right with you. I'm more of a potions witch.",
      "Welcome! Before you ask: have you cleared your cache and cookies? I'm told the cookies aren't even edible.",
      "Greetings! Did you restart it? Restart it. [cackles] Three hundred years of wisdom, right there.",
    ],
    morning: ["Good morning! The coffee machine and I have come to an understanding. Welcome in."],
    afternoon: ["Good afternoon! I still haven't broken the printer's curse. Welcome anyway."],
    evening: ["Good evening! Nearly closing time, even for the undead. Come on in."],
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
// A saved config holds a full copy of the lines. If they are still the
// original plain greeter lines (never edited), move them to the witch set.
const ORIGINAL_ANY = ['Hello there! Welcome in.', 'Oh, a visitor! Come in, come in.', 'Welcome! Someone will be right with you.', "Well, hello. Don't mind me, I just work here."];
const ORIGINAL_TEAM2 = '{name}. Back again, I see.';
if (JSON.stringify(config.lines.any) === JSON.stringify(ORIGINAL_ANY)) config.lines = DEFAULTS.lines;
// Likewise the original 8-6 weekday hours, never changed by hand -> no hours.
if (config.hours && config.hours.start === '08:00' && config.hours.end === '18:00' && config.hours.weekdaysOnly) config.hours = DEFAULTS.hours;
if ((config.teamLines || [])[1] === ORIGINAL_TEAM2 && config.teamLines.length === 4) config.teamLines = DEFAULTS.teamLines;
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
  isAsleep: () => !!(greeterRef && greeterRef.status().asleep),
});
const faces = createFaces({ log });
let cameraRef = null;
const greeter = greeterRef = createGreeter({
  lily, log, getConfig, getElevenKey: elevenKey,
  onGreeted: (line) => converse.afterGreeting(line),
  inConversation: () => converse.inConversation(),
  faces,
  outfit: createOutfit({ log, getApiKey: anthropicKey }),
  nextFrame: (ms) => (cameraRef ? cameraRef.nextJpeg(ms) : null),
});
const camera = cameraRef = createCamera({ log, getConfig, onArrival: () => greeter.onCamera() });
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
app.use(express.json({ limit: '8mb' }));   // team photos arrive as base64
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req.body || {}, req)) }); }
  catch (e) { log(`error: ${e.message}`); res.status(409).json({ ok: false, error: e.message }); }
};

app.get('/api/status', (req, res) => res.json({
  lily: lily.status(), camera: camera.status(), chime: chime.status(), greeter: greeter.status(),
  converse: converse.status(), faces: { ...faces.status(), enabled: !!config.faces.enabled }, keys: { elevenlabs: !!elevenKey(), anthropic: !!anthropicKey() }, log: logLines.slice(-60),
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
  if ('voiceId' in body && !body.voiceId) config.voiceId = GREETER_VOICE;   // blank = back to the greeter default
  if (body.teamLines) config.teamLines = body.teamLines;
  if (config.faces.enabled) faces.start();
  if (body.lines || body.voiceId || body.teamLines || body.faces) greeter.warm();
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
  manualHold = false;
  await lily.connect(address);
  if (config.autoArm) await lily.arm(true);
  return { lily: lily.status() };
}));
app.post('/api/lily/disconnect', route(async () => { manualHold = true; return { lily: await lily.disconnect() }; }));
app.post('/api/lily/arm', route(async ({ on }) => { manualHold = !on; return { lily: await lily.arm(on) }; }));
app.post('/api/lily/mood', route(async ({ mood }) => ({ lily: await lily.setMood(mood) })));
app.post('/api/lily/volume', route(async ({ volume }) => ({ lily: await lily.volume(volume) })));
app.post('/api/lily/audio/connect', route(async ({ address, pair }) => { manualHold = false; return { lily: await lily.audioConnect(address, { pair }) }; }));
app.post('/api/lily/audio/disconnect', route(async () => { manualHold = true; return { lily: await lily.audioDisconnect() }; }));

// Camera
app.get('/api/camera/list', (req, res) => res.json(listCameras()));
app.get('/api/camera/snapshot.bmp', (req, res) => {
  const img = camera.snapshot();
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.type, 'Cache-Control': 'no-store' }).send(img.data);
});

// Mic / chime
app.get('/api/mic/list', async (req, res) => res.json(await listMics()));
app.post('/api/chime/learn', route(async ({ seconds }) => ({ learned: await chime.learn(Number(seconds) || 5) })));

// Team faces (photos stay in greeter/team/ on this computer)
app.post('/api/team/photo', route(async ({ name, jpeg }) => {
  if (!jpeg) throw new Error('photo required');
  const team = await faces.addPhoto(name, Buffer.from(String(jpeg).replace(/^data:[^,]*,/, ''), 'base64'));
  greeter.warm();
  return { team };
}));
app.post('/api/team/capture', route(async ({ name }) => {
  const jpeg = await camera.nextJpeg(2000);
  if (!jpeg) throw new Error('No camera picture — is the webcam on?');
  const team = await faces.addPhoto(name, jpeg);
  greeter.warm();
  return { team };
}));
app.post('/api/team/remove', route(async ({ name }) => ({ team: await faces.removePerson(name) })));

// Greeting
app.post('/api/say', route(async ({ text }) => {
  const t = String(text || '').trim().slice(0, 200);
  if (!t) throw new Error('Nothing to say');
  await greeter.say(t);
  return {};
}));
app.get('/phone', (req, res) => res.sendFile(path.join(__dirname, 'public', 'phone.html')));
// Sleep / wake: she goes dark and quiet (lantern off, motors disarmed) but the
// computer stays on. Wake = straight back to greeting.
app.post('/api/sleep', route(async ({ asleep }) => {
  const on = !!asleep;
  greeter.setAsleep(on);
  if (on) {
    manualHold = true;
    await lily.setMood('off').catch(() => {});
    await lily.arm(false).catch(() => {});
  } else {
    manualHold = false;
    keepLilyConnected();
  }
  return { greeter: greeter.status() };
}));

// Shut down for the night: Lily dark + disarmed, then a clean poweroff
// (setup-linux.sh allows exactly `sudo systemctl poweroff` without a password).
app.post('/api/shutdown', route(async ({ confirm }) => {
  if (confirm !== true) throw new Error('confirm required');
  log('shutting down for the night');
  greeter.setAsleep(true);
  manualHold = true;
  await lily.setMood('off').catch(() => {});
  await lily.arm(false).catch(() => {});
  await new Promise((resolve, reject) => {
    execFile('sudo', ['-n', '/usr/bin/systemctl', 'poweroff'], { timeout: 10000 }, (err, out, errOut) => {
      if (err) reject(new Error(`could not power off (${String(errOut || err.message).trim().slice(0, 120)}) — run greeter/setup-linux.sh once more to allow it`));
      else resolve();
    });
  });
  return { shuttingDown: true };
}));

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
  faces.start();   // cheap when idle; needed for adding photos even before it's switched on
  converse.warmup();
  greeter.warm().catch(() => {});
  keepLilyConnected();
  setInterval(keepLilyConnected, 20000);
}

// Lily is unplugged every night and may come back before or after this
// computer, so keep trying: body first, then motors + lantern, then speaker.
// Her BLE driver reconnects on its own but never re-arms the motors (safety),
// so re-arm here when that happens.
let keeping = false;
let manualHold = false;   // someone tapped Disconnect/Disarm — leave her alone until they reconnect
async function keepLilyConnected() {
  if (keeping || manualHold) return;
  keeping = true;
  try {
    let lc = {};
    try { lc = JSON.parse(fs.readFileSync(process.env.LILY_CONFIG, 'utf8')); } catch (_) {}
    let st = lily.status();
    if (lc.bleAddress && !st.connected && !st.connecting && !st.reconnecting) {
      try { await lily.connect(); log('Lily: body connected'); }
      catch (e) { if (!keepLilyConnected.quiet) log(`Lily not reachable yet (${e.message}) — retrying every 20 s`); keepLilyConnected.quiet = true; }
    }
    st = lily.status();
    if (st.connected) {
      keepLilyConnected.quiet = false;
      if (config.autoArm && !st.armed) {
        await lily.arm(true).catch(e => log(`arm: ${e.message}`));
        await lily.setMood(config.lanternMood || 'calm').catch(() => {});
      }
      if (lc.audioAddress && !(st.audio && st.audio.connected)) {
        try { await lily.audioConnect(); log('Lily: speaker connected'); keepLilyConnected.quietSpk = false; }
        catch (e) { if (!keepLilyConnected.quietSpk) log(`Lily speaker not connected yet (${e.message}) — retrying`); keepLilyConnected.quietSpk = true; }
      }
    }
  } finally { keeping = false; }
}

function shutdown() {
  camera.stop(); chime.stop(); faces.stop();
  Promise.race([lily.arm(false).catch(() => {}), new Promise(r => setTimeout(r, 1500))]).then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
