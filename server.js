const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config ───────────────────────────────────────────────────────────────────
let config = {
  receiverIp:   '192.168.1.190',
  receiverPort: 60128,
  maxVol: { z1: 60, z2: 48, z3: 44, sub: 52 },
};

// ─── Settings ─────────────────────────────────────────────────────────────────
let settings = {
  hapticFeedback: true,
};

// ─── Govee Devices ────────────────────────────────────────────────────────────
// Slot roles (one slot per zone — each zone is a tethered pair on ONE controller IP):
//  1. skeleton — orange/red base, brightens when EITHER skeleton talks
//  2. witch    — deep purple base (both witches)
//  3. moon     — cool blue, consistent, white flash on Overhead only
//  4. storm    — cold blue, tracks storm progression dim → electric
//  5. cauldron — separate A19 bulb, green base RGB(0,180,0), deep red
//                RGB(180,0,0) on spell trigger, pulses back to green after 20s
let goveeDevices = [];
const GOVEE_IPS = { skeleton:'', witch:'', moon:'', storm:'', cauldron:'' };
const GOVEE_SLOT_IDS = {};

const GOVEE_CMD_PORT    = 4003;
const GOVEE_LISTEN_PORT = 4002;
const GOVEE_SCAN_PORT   = 4001;
const GOVEE_MULTICAST   = '239.255.255.250';

const goveeSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
goveeSocket.on('error', (err) => console.error(`[GOVEE] ${err.message}`));
goveeSocket.bind(GOVEE_LISTEN_PORT, () => {
  try { goveeSocket.addMembership(GOVEE_MULTICAST); } catch (_) {}
  console.log(`[GOVEE] Listening on :${GOVEE_LISTEN_PORT}`);
});
goveeSocket.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    const m = data?.msg;
    if (!m) return;
    if (m.cmd === 'scan') {
      const ip = rinfo.address;
      if (!goveeDevices.find(d => d.ip === ip) && goveeDevices.length < 12) {
        goveeDevices.push({
          id: `govee-${Date.now()}`,
          name: m.data?.sku || `Light ${goveeDevices.length + 1}`,
          ip, model: m.data?.sku || 'Unknown',
          on: true, color: { r:255, g:98, b:0 }, brightness: 100,
        });
        broadcastGovee();
      }
    }
    if (m.cmd === 'devStatus') {
      const dev = goveeDevices.find(d => d.ip === rinfo.address);
      if (dev) {
        if (m.data?.onOff !== undefined) dev.on = !!m.data.onOff;
        if (m.data?.brightness !== undefined) dev.brightness = m.data.brightness;
        if (m.data?.color) dev.color = m.data.color;
        broadcastGovee();
      }
    }
  } catch (_) {}
});

function goveeSend(ip, cmdObj) {
  return new Promise((resolve, reject) => {
    if (!ip) return resolve();
    const payload = Buffer.from(JSON.stringify({ msg: cmdObj }));
    goveeSocket.send(payload, 0, payload.length, GOVEE_CMD_PORT, ip, (err) => {
      err ? reject(err) : resolve();
    });
  });
}

async function goveeSetColor(r, g, b, ids) {
  const cmd = { cmd: 'colorwc', data: { color: { r, g, b }, colorTemInKelvin: 0 } };
  const targets = ids ? goveeDevices.filter(d => ids.includes(d.id)) : goveeDevices;
  await Promise.allSettled(targets.map(d => {
    d.color = { r, g, b };
    return goveeSend(d.ip, cmd);
  }));
  broadcastGovee();
}

async function goveeSetBrightness(pct, ids) {
  const val = Math.max(0, Math.min(100, pct));
  const cmd = { cmd: 'brightness', data: { value: val } };
  const targets = ids ? goveeDevices.filter(d => ids.includes(d.id)) : goveeDevices;
  await Promise.allSettled(targets.map(d => {
    d.brightness = val;
    return goveeSend(d.ip, cmd);
  }));
  broadcastGovee();
}

async function goveeSetPower(on, ids) {
  const cmd = { cmd: 'turn', data: { value: on ? 1 : 0 } };
  const targets = ids ? goveeDevices.filter(d => ids.includes(d.id)) : goveeDevices;
  await Promise.allSettled(targets.map(d => { d.on = on; return goveeSend(d.ip, cmd); }));
  broadcastGovee();
}

function broadcastGovee() {
  broadcast({ type: 'govee', data: goveeDevices });
}

const GOVEE_COLORS = {
  orange:    { r:255, g: 98, b:  0 },
  green:     { r:  0, g:180, b: 30 },
  purple:    { r:100, g:  0, b:180 },
  blue:      { r:  0, g: 80, b:255 },
  coldblue:  { r: 30, g:120, b:255 },
  white:     { r:255, g:255, b:255 },
  red:       { r:204, g:  0, b:  0 },
  deepred:   { r:120, g:  0, b:  0 },
  bloodred:  { r:180, g:  0, b:  0 },
  teal:      { r:  0, g:200, b:180 },
  pink:      { r:255, g: 20, b:120 },
  yellow:    { r:255, g:200, b:  0 },
  witchgreen:{ r:  0, g:180, b: 30 },
  off:       { r:  0, g:  0, b:  0 },
};

// Base show scheme — every slot's resting color + brightness
const SLOT_BASES = {
  skeleton: { color: { r:255, g: 80, b:  0 }, bri: 25 }, // orange/red fire base
  witch:    { color: { r:100, g:  0, b:180 }, bri: 30 }, // deep purple
  moon:     { color: { r: 60, g:120, b:255 }, bri: 40 }, // cool steady blue
  storm:    { color: { r: 30, g:120, b:255 }, bri: 15 }, // cold blue, storm-driven
  cauldron: { color: { r:  0, g:180, b:  0 }, bri: 60 }, // green boil
};

// Return Govee device IDs for named slots
function getSlotIds(...slots) {
  return slots.map(s => GOVEE_SLOT_IDS[s]).filter(Boolean);
}

// Set every configured slot to its base show look
async function applyShowScheme() {
  for (const [slot, base] of Object.entries(SLOT_BASES)) {
    const ids = getSlotIds(slot);
    if (!ids.length) continue;
    await goveeSetColor(base.color.r, base.color.g, base.color.b, ids).catch(() => {});
    await goveeSetBrightness(base.bri, ids).catch(() => {});
  }
  broadcastLog('Lights: show scheme applied', 'LIGHT');
  // Scheme button = show look + living effects
  startEffects();
}

// ─── Living lighting effects engine ──────────────────────────────────────────
// Recursive setTimeout loops give each fixture organic, never-repeating motion:
//  - skeleton: flickering fire illusion (single loop, tethered pair)
//  - witch: slow purple breathing pulse
//  - cauldron: slow rolling boil (green) / faster red pulse during a spell
// moonlights are steady (set once by applyShowScheme); storm slots are driven
// by flashLights. Loops only touch slots with assigned IDs and skip their
// goveeSend while effects.suspended (e.g. during the Overhead white blast),
// but keep rescheduling so they resume seamlessly.
const effects = {
  running: false,
  suspended: false,
  timers: {},
  skelTalking: { left: false, right: false },
  cauldronMode: 'green',
  spellSeq: null, // { seq, colors, idx } while a named spell runs on the cauldron
};

const FIRE_PALETTE = [
  { r: 255, g:  80, b:  0 },
  { r: 255, g:  40, b:  0 },
  { r: 200, g:  30, b:  0 },
  { r: 255, g: 120, b:  0 },
  { r: 255, g: 160, b: 20 },
];

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Skeleton fire illusion — ONE loop for the tethered pair. The fire burns
// brighter while EITHER skeleton is talking (audio still has left/right sides).
function skelFireTick() {
  if (!effects.running) return;
  const ids = getSlotIds('skeleton');
  if (ids.length && !effects.suspended) {
    const c = FIRE_PALETTE[Math.floor(Math.random() * FIRE_PALETTE.length)];
    let bri;
    const roll = Math.random();
    const talking = effects.skelTalking.left || effects.skelTalking.right;
    if (talking) {
      bri = Math.round(randBetween(45, 65)); // talking — fire burns brighter
    } else if (roll < 0.10) {
      bri = Math.round(randBetween(55, 70)); // bright flare
    } else if (roll < 0.20) {
      bri = Math.round(randBetween(8, 14));  // dim smolder
    } else {
      bri = Math.round(randBetween(18, 35)); // normal flicker
    }
    goveeSetColor(c.r, c.g, c.b, ids).catch(() => {});
    goveeSetBrightness(bri, ids).catch(() => {});
  }
  const delay = Math.round(randBetween(250, 1400));
  effects.timers.skeleton = setTimeout(skelFireTick, delay);
}

// Witch breathing pulse — one loop for the witch slot (tethered pair).
// Sine-like brightness wave 18–42 over a ~8s cycle, stepping every ~800ms.
const BREATH_LEVELS = [18, 22, 28, 35, 40, 42, 40, 35, 28, 22];
let breathPhase = 0;

function witchBreathTick() {
  if (!effects.running) return;
  const ids = getSlotIds('witch');
  if (ids.length && !effects.suspended) {
    const bri = BREATH_LEVELS[breathPhase % BREATH_LEVELS.length];
    goveeSetColor(100, 0, 180, ids).catch(() => {});
    goveeSetBrightness(bri, ids).catch(() => {});
  }
  breathPhase++;
  effects.timers.witchBreath = setTimeout(witchBreathTick, 800);
}

// Cauldron organic boil — slow rolling green boil, deep red pulse during spell
let boilPhase = 0;

function cauldronBoilTick() {
  if (!effects.running) return;
  const ids = getSlotIds('cauldron');
  const spell = effects.cauldronMode === 'spell';
  if (ids.length && !effects.suspended) {
    let bri;
    if (spell && effects.spellSeq) {
      // Named spell sequence — NO WHITE, ever
      const sq = effects.spellSeq;
      let c = sq.colors[0];
      switch (sq.seq) {
        case 'pulse': { // single color brightness wave 40–90
          const wave = (Math.sin(sq.idx * 0.7) + 1) / 2;
          bri = Math.round(40 + wave * 50);
          break;
        }
        case 'flash': // sharp bright hits then dips
          bri = (sq.idx % 2 === 0) ? 90 : 30;
          break;
        case 'hold': // steady-ish organic
          bri = Math.round(randBetween(55, 75));
          break;
        case 'cycle': // advance through colors each tick
          c = sq.colors[sq.idx % sq.colors.length];
          bri = Math.round(randBetween(60, 90));
          break;
        default:
          bri = Math.round(randBetween(50, 90));
      }
      sq.idx++;
      goveeSetColor(c.r, c.g, c.b, ids).catch(() => {});
    } else if (spell) {
      // Spell mode with no sequence (legacy) — deep red pulse, NO WHITE
      bri = Math.round(randBetween(50, 90));
      goveeSetColor(180, 0, 0, ids).catch(() => {});
    } else {
      // Slow rolling boil — brightness drifts in slow waves 25–60,
      // occasional flare to 80
      const wave = (Math.sin(boilPhase * 0.6) + 1) / 2; // 0..1
      bri = Math.round(25 + wave * 35 + randBetween(-4, 4));
      bri = Math.max(25, Math.min(60, bri));
      if (Math.random() < 0.08) bri = 80; // flare
      goveeSetColor(0, 180, 0, ids).catch(() => {});
    }
    goveeSetBrightness(bri, ids).catch(() => {});
  }
  boilPhase++;
  let delay;
  if (spell && effects.spellSeq) {
    const ranges = { pulse: [400, 800], flash: [250, 600], hold: [400, 900], cycle: [200, 500] };
    const [lo, hi] = ranges[effects.spellSeq.seq] || [300, 900];
    delay = Math.round(randBetween(lo, hi));
  } else if (spell) {
    delay = Math.round(randBetween(300, 900));
  } else {
    delay = Math.round(randBetween(600, 1800));
  }
  effects.timers.cauldron = setTimeout(cauldronBoilTick, delay);
}

function startEffects() {
  if (effects.running) return;
  effects.running = true;
  effects.suspended = false;
  skelFireTick();
  witchBreathTick();
  cauldronBoilTick();
  broadcastLog('Living effects ON — skeleton fire, witch breathing, cauldron boil', 'LIGHT');
  broadcastState();
}

function stopEffects() {
  if (!effects.running && !Object.keys(effects.timers).length) return;
  effects.running = false;
  effects.suspended = false;
  for (const key of Object.keys(effects.timers)) {
    clearTimeout(effects.timers[key]);
    delete effects.timers[key];
  }
  effects.skelTalking.left = false;
  effects.skelTalking.right = false;
  effects.cauldronMode = 'green';
  effects.spellSeq = null;
  broadcastLog('Living effects OFF', 'LIGHT');
  broadcastState();
}

// Storm lighting per progression stage (0-4).
// 0 Distant:        storm slot cold blue 15%
// 1 Getting Closer: storm slot cold blue 30%
// 2 Close:          storm slot brighter cold blue 50%
// 3 Very Close:     storm slot bright electric blue 75%
// 4 Overhead:       ALL slots full white blast, back to base after 600ms
async function flashLights(stage) {
  // Fallback: if no light is assigned to the storm slot yet, flash ALL lights so
  // testing works before slot setup. Assign the Storm slot for show behavior.
  let stormIds = getSlotIds('storm');
  if (!stormIds.length && goveeDevices.length) {
    broadcastLog('Storm flash: no storm slot assigned — flashing all lights (assign Storm slot in Test tab)', 'LIGHT');
    stormIds = undefined; // undefined targets all devices in goveeSetColor/Brightness
  } else if (!stormIds.length) {
    broadcastLog('Storm flash: no Govee lights connected', 'LIGHT');
    return;
  }
  if (stage <= 0) {
    await goveeSetColor(30, 120, 255, stormIds); await goveeSetBrightness(15, stormIds);
  } else if (stage === 1) {
    await goveeSetColor(30, 120, 255, stormIds); await goveeSetBrightness(30, stormIds);
  } else if (stage === 2) {
    await goveeSetColor(50, 140, 255, stormIds); await goveeSetBrightness(50, stormIds);
  } else if (stage === 3) {
    await goveeSetColor(80, 180, 255, stormIds); await goveeSetBrightness(75, stormIds);
  } else {
    // Overhead — full white blast on every configured slot (or all lights if
    // no slots). ALL slots including cauldron — owner spec: "no exceptions".
    let allIds = getSlotIds(...Object.keys(SLOT_BASES));
    const usingSlots = allIds.length > 0;
    if (!usingSlots) {
      if (!goveeDevices.length) return;
      allIds = undefined; // all devices
    }
    const snapshot = usingSlots ? null : goveeDevices.map(d => ({ id: d.id, color: {...d.color}, brightness: d.brightness }));
    // Suspend effect loops so they don't fight the blast — they keep
    // rescheduling and resume on their next tick after the restore.
    effects.suspended = true;
    await goveeSetColor(255, 255, 255, allIds);
    await goveeSetBrightness(100, allIds);
    setTimeout(async () => {
      if (usingSlots) {
        await applyShowScheme().catch(() => {});
        effects.suspended = false;
      } else {
        // No slots configured — restore each light to what it was before the blast
        for (const snap of snapshot) {
          const dev = goveeDevices.find(d => d.id === snap.id);
          if (!dev) continue;
          await goveeSend(dev.ip, { cmd: 'colorwc', data: { color: snap.color, colorTemInKelvin: 0 } }).catch(() => {});
          await goveeSend(dev.ip, { cmd: 'brightness', data: { value: snap.brightness } }).catch(() => {});
          dev.color = snap.color;
          dev.brightness = snap.brightness;
        }
        broadcastGovee();
        effects.suspended = false;
      }
    }, 600);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  connected:   false,
  fogActive:   false,
  fogTimer:    null,
  stormActive: false,
  stormTimer:  null,
  stormNextAt: null,
  kidMode:     false,
  paused:      false,
  sceneMode:   'normal',
  volumes:     { z1: 30, z2: 25, z3: 20, sub: 30 },
  mute:        { z1: false, z2: false, z3: false },
};

// ─── Sound presets ────────────────────────────────────────────────────────────
let soundPreset = 'normal';
const SOUND_PRESETS = {
  normal: { z1: 30, z2: 28, z3: 26 },
  boost:  { z1: 40, z2: 38, z3: 36 },
};

// ─── ISCP ─────────────────────────────────────────────────────────────────────
function buildISCPPacket(command) {
  const msgBody  = `!1${command}\r\n`;
  const msgBytes = Buffer.from(msgBody, 'ascii');
  const header   = Buffer.alloc(16);
  header.write('ISCP', 0, 'ascii');
  header.writeUInt32BE(16, 4);
  header.writeUInt32BE(msgBytes.length, 8);
  header.writeUInt8(1, 12);
  return Buffer.concat([header, msgBytes]);
}

function sendISCP(command) {
  return new Promise((resolve, reject) => {
    const packet  = buildISCPPacket(command);
    const sock    = new net.Socket();
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error('ISCP timeout')); }, 3000);
    sock.connect(config.receiverPort, config.receiverIp, () => {
      console.log(`[ISCP] → ${command}`);
      sock.write(packet);
    });
    sock.on('data', (data) => {
      clearTimeout(timeout);
      const response = data.slice(16).toString('ascii').trim();
      console.log(`[ISCP] ← ${response}`);
      sock.destroy();
      resolve(response);
    });
    sock.on('error', (err) => { clearTimeout(timeout); reject(err); });
    sock.on('close', () => clearTimeout(timeout));
  });
}

// ─── ISCP Command Queue ───────────────────────────────────────────────────────
const iscpQueue = [];
let iscpRunning = false;
function queueISCP(command) {
  return new Promise((resolve, reject) => {
    iscpQueue.push({ command, resolve, reject });
    if (!iscpRunning) drainISCP();
  });
}
async function drainISCP() {
  if (iscpRunning || iscpQueue.length === 0) return;
  iscpRunning = true;
  const { command, resolve, reject } = iscpQueue.shift();
  try { resolve(await sendISCP(command)); } catch (e) { reject(e); }
  iscpRunning = false;
  if (iscpQueue.length > 0) setImmediate(drainISCP);
}

// ─── Debounce helper ──────────────────────────────────────────────────────────
const debounceMap = {};
function debounceRoute(key, ms, fn) {
  if (debounceMap[key]) return false;
  debounceMap[key] = true;
  setTimeout(() => { delete debounceMap[key]; }, ms);
  fn();
  return true;
}

async function testConnection() {
  try {
    await sendISCP('PWRQSTN');
    state.connected = true;
  } catch (e) {
    state.connected = false;
    console.warn(`[HAUNT] Receiver unreachable: ${e.message}`);
  }
  broadcastState();
}

// ─── State persistence ────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'show-state.json');
function saveShowState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      volumes: state.volumes,
      sceneMode: state.sceneMode,
      kidMode: state.kidMode,
      maxVol: config.maxVol,
      soundPreset,
    }), 'utf8');
  } catch(_) {}
}
function loadShowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.volumes) state.volumes = { ...state.volumes, ...saved.volumes };
    if (saved.sceneMode) state.sceneMode = saved.sceneMode;
    if (saved.kidMode !== undefined) state.kidMode = saved.kidMode;
    if (saved.maxVol) config.maxVol = { ...config.maxVol, ...saved.maxVol };
    if (saved.soundPreset) soundPreset = saved.soundPreset;
    console.log('[HAUNT] Show state restored from disk');
  } catch(_) {}
}

// ─── Govee slot IP persistence ────────────────────────────────────────────────
const SLOTS_FILE = path.join(__dirname, 'govee-slots.json');
const SLOT_LABELS = { skeleton:'Skeleton', witch:'Witches', moon:'Moonlight', storm:'Storm', cauldron:'Cauldron' };
function saveSlotIPs() {
  try {
    fs.writeFileSync(SLOTS_FILE, JSON.stringify(GOVEE_IPS), 'utf8');
  } catch(_) {}
}
function loadSlotIPs() {
  try {
    const saved = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
    for (const slot of Object.keys(GOVEE_IPS)) {
      const ip = saved?.[slot];
      if (!ip) continue;
      let dev = goveeDevices.find(d => d.ip === ip);
      if (!dev) {
        dev = {
          id: `govee-${slot}`, name: SLOT_LABELS[slot] || slot,
          ip, model: 'Manual', on: true, color: { r:255, g:98, b:0 }, brightness: 100,
        };
        goveeDevices.push(dev);
      }
      GOVEE_IPS[slot] = ip;
      GOVEE_SLOT_IDS[slot] = dev.id;
    }
    console.log('[HAUNT] Govee slot IPs restored from disk');
  } catch(_) {}
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}
function broadcastState() { broadcast({ type: 'state', data: stateSnapshot() }); }
const LOG_FILE = path.join(__dirname, 'show-log.txt');
function broadcastLog(msg, category = 'SYSTEM') {
  broadcast({ type: 'log', msg, category });
  console.log(`[${category}] ${msg}`);
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [${category}] ${msg}\n`, 'utf8');
  } catch(_) {}
}

function anyVlcRunning() {
  return !!(stormProcess || skeletonProcess || witchProcess || witchSideProcess ||
            ambientProcess || fxProcess || atmosfxProcess || soundProcess);
}

function stateSnapshot() {
  const strike = STRIKE_SEQUENCE[strikeIndex];
  return {
    connected:        state.connected,
    fogActive:        state.fogActive,
    stormActive:      state.stormActive,
    stormNextAt:      state.stormNextAt,
    stormStrikeIndex: strikeIndex,
    stormStrikeName:  `${strike.emoji} ${strike.name}`,
    kidMode:          state.kidMode,
    paused:           state.paused,
    sceneMode:        state.sceneMode,
    volumes:          state.volumes,
    mute:             state.mute,
    fogAutoActive:    fogAuto.active,
    fogAutoNextAt:    fogAuto.nextAt,
    fogWarmup:        fogAuto.warmup,
    soundPreset,
    ambientActive:    ambientSystem.active,
    vlcActive:        anyVlcRunning(),
    goveeSlotsConfigured: Object.values(GOVEE_SLOT_IDS).filter(Boolean).length,
    effectsRunning:   effects.running,
    hostContext:      hostContext.text,
  };
}

// ─── Show host context field ──────────────────────────────────────────────────
// Free-text note from the host about who's at the yard right now. The AI
// conductor uses it for exactly ONE interaction, then calls markContextUsed()
// to expire it (enforcement lands in the AI conductor phase).
let hostContext = { text: '', setAt: null, used: false };

function markContextUsed() {
  hostContext.used = true;
  hostContext.text = '';
  broadcastState();
}

loadShowState();
loadSlotIPs();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state',    data: stateSnapshot() }));
  ws.send(JSON.stringify({ type: 'config',   data: config }));
  ws.send(JSON.stringify({ type: 'govee',    data: goveeDevices }));
  ws.send(JSON.stringify({ type: 'settings', data: settings }));
});

// ─── Volume helpers ───────────────────────────────────────────────────────────
function clampVol(zone, val) {
  return Math.max(0, Math.min(config.maxVol[zone] || 80, val));
}
function volToHex(v) { return v.toString(16).toUpperCase().padStart(2, '0'); }

const ZONE_CMD = { z1: 'MVL', z2: 'ZVL', z3: 'Z3L' };
const MUTE_CMD = { z1: 'AMT', z2: 'ZMT', z3: 'MT3' };

// Ducking helper — snapshot current zone volume, lower by `amount`,
// restore after `durationMs`.
function duckZone(zone, amount, durationMs) {
  const original = state.volumes[zone];
  const ducked = clampVol(zone, Math.max(0, original - amount));
  if (ducked === original) return;
  queueISCP(`${ZONE_CMD[zone]}${volToHex(ducked)}`)
    .then(() => { state.volumes[zone] = ducked; broadcastState(); })
    .catch(() => {});
  setTimeout(() => {
    queueISCP(`${ZONE_CMD[zone]}${volToHex(original)}`)
      .then(() => { state.volumes[zone] = original; broadcastState(); })
      .catch(() => {});
  }, durationMs);
}

// ─── Fog helpers ──────────────────────────────────────────────────────────────
async function fogOn() {
  await sendISCP('TGA01');
  state.fogActive = true;
  broadcastState();
  broadcastLog('Fog ON', 'FOG');
}
async function fogOff() {
  if (state.fogTimer) { clearTimeout(state.fogTimer); state.fogTimer = null; }
  await sendISCP('TGA00');
  state.fogActive = false;
  broadcastState();
  broadcastLog('Fog OFF', 'FOG');
}
function fogBurst(ms) {
  fogOn().catch(() => {});
  if (state.fogTimer) clearTimeout(state.fogTimer);
  state.fogTimer = setTimeout(() => fogOff().catch(() => {}), Math.min(ms, 30000));
}

// ─── Fog Auto-Timer ───────────────────────────────────────────────────────────
let fogAuto = {
  active:       false,
  burstMs:      5000,
  intervalMs:   600000, // 10 minutes
  nextAt:       null,
  timer:        null,
  warmup:       false,
  warmupTimer:  null,
};

function scheduleFogBurst() {
  if (!fogAuto.active) return;
  fogAuto.nextAt = Date.now() + fogAuto.intervalMs;
  broadcastState();
  broadcastLog('Fog Auto: next burst in 10:00', 'FOG');
  fogAuto.timer = setTimeout(() => {
    if (!fogAuto.active) return;
    broadcastLog('Fog Auto: firing burst', 'FOG');
    fogBurst(fogAuto.burstMs);
    scheduleFogBurst();
  }, fogAuto.intervalMs);
}

function startFogAuto() {
  if (fogAuto.active) return;
  fogAuto.active = true;
  fogAuto.warmup = true;
  fogAuto.nextAt = null;
  broadcastLog('Fog Auto-Timer ON — 4 min warmup', 'FOG');
  broadcastState();
  fogAuto.warmupTimer = setTimeout(() => {
    fogAuto.warmup = false;
    broadcastLog('Fog Auto-Timer: warmup complete — cycle starting', 'FOG');
    broadcastState();
    scheduleFogBurst();
  }, 240000); // 4 minutes
}

function stopFogAuto() {
  fogAuto.active = false;
  fogAuto.warmup = false;
  fogAuto.nextAt = null;
  if (fogAuto.timer) { clearTimeout(fogAuto.timer); fogAuto.timer = null; }
  if (fogAuto.warmupTimer) { clearTimeout(fogAuto.warmupTimer); fogAuto.warmupTimer = null; }
  broadcastState();
  broadcastLog('Fog Auto-Timer OFF', 'FOG');
}

// ─── Storm progressive sequence engine ───────────────────────────────────────
// Storm volumes are LOCKED — never affected by the Normal/Boost preset.
// Strikes hit all three zones full blast (z1/z3 mirror z2 intensity).
const STRIKE_SEQUENCE = [
  { name: 'Distant',       emoji: '🌧', z1Vol: 48, z2Vol: 48, z3Vol: 48, fog: false, flash: 0 },
  { name: 'Getting Closer',emoji: '⛈', z1Vol: 46, z2Vol: 46, z3Vol: 46, fog: false, flash: 1 },
  { name: 'Close',         emoji: '🌩', z1Vol: 42, z2Vol: 42, z3Vol: 42, fog: false, flash: 2 },
  { name: 'Very Close',    emoji: '⚡', z1Vol: 38, z2Vol: 38, z3Vol: 38, fog: false, flash: 3 },
  { name: 'Overhead',      emoji: '💥', z1Vol: 36, z2Vol: 36, z3Vol: 36, fog: true,  flash: 4 },
];

const STRIKE_INTERVAL_MS = 120000; // 2 minutes

let strikeIndex = 0;

async function fireStrike(idx) {
  const s = STRIKE_SEQUENCE[idx];
  broadcastLog(`Storm ${idx + 1}/5 — ${s.emoji} ${s.name}`, 'AUDIO');
  playStormClip(s.name === 'Overhead');

  try {
    const z1 = clampVol('z1', s.z1Vol);
    const z2 = clampVol('z2', s.z2Vol);
    const z3 = clampVol('z3', s.z3Vol);
    await queueISCP(`${ZONE_CMD.z1}${volToHex(z1)}`);
    await queueISCP(`${ZONE_CMD.z2}${volToHex(z2)}`);
    await queueISCP(`${ZONE_CMD.z3}${volToHex(z3)}`);
    state.volumes.z1 = z1;
    state.volumes.z2 = z2;
    state.volumes.z3 = z3;
    broadcastState();

    if (s.fog) fogBurst(5000);

    const delay = 1200 + Math.random() * 800;
    setTimeout(() => {
      broadcastLog(`Storm: lightning flash [stage ${s.flash}]`, 'LIGHT');
      flashLights(s.flash).catch(() => {});
    }, delay);
  } catch (e) {
    broadcastLog(`Storm error: ${e.message}`, 'SYSTEM');
  }
}

function scheduleNextStrike() {
  if (!state.stormActive) return;
  const strike = STRIKE_SEQUENCE[strikeIndex];
  state.stormNextAt = Date.now() + STRIKE_INTERVAL_MS;
  broadcastState();
  broadcastLog(`Storm: next in 2:00 — ${strike.emoji} ${strike.name} (${strikeIndex + 1}/5)`, 'SYSTEM');

  state.stormTimer = setTimeout(async () => {
    if (!state.stormActive || state.paused) return scheduleNextStrike();
    await fireStrike(strikeIndex);
    strikeIndex = (strikeIndex + 1) % STRIKE_SEQUENCE.length;
    scheduleNextStrike();
  }, STRIKE_INTERVAL_MS);
}

// ─── Named spell system ───────────────────────────────────────────────────────
// Evelina's spells — each drives the cauldron slot with its own color/sequence.
// grandritual is NEVER picked randomly; explicit request only (Overhead / AI).
const SPELLS = {
  binding:    { name: 'Spell of Binding',    seq: 'pulse', colors: [{ r: 0,   g: 40,  b: 200 }] },                 // deep blue pulse
  calling:    { name: 'Spell of Calling',    seq: 'flash', colors: [{ r: 255, g: 170, b: 0   }] },                 // amber/gold flash
  unraveling: { name: 'Spell of Unraveling', seq: 'cycle', colors: [{ r: 0, g: 180, b: 0 }, { r: 140, g: 0, b: 200 }] }, // rapid green↔purple
  memory:     { name: 'Spell of Memory',     seq: 'hold',  colors: [{ r: 150, g: 0, b: 30 }] },                    // deep crimson
  grandritual: { name: 'Grand Ritual',       seq: 'cycle', colors: [
    { r: 0, g: 40, b: 200 }, { r: 255, g: 170, b: 0 }, { r: 0, g: 180, b: 0 },
    { r: 140, g: 0, b: 200 }, { r: 150, g: 0, b: 30 },
  ] }, // all spell colors, rapid
};

let lastSpell = null;

// ─── Character bible ──────────────────────────────────────────────────────────
// The full story/character reference for the show — consumed by the future AI
// conductor via GET /api/character-bible.
const CHARACTER_BIBLE = {
  story: {
    title: 'The Hollow Storm',
    summary: 'Three hundred years ago, a great ritual was attempted on this ground and failed. ' +
      'The failure tore a hollow in the sky — the Hollow Storm — that returns every year, ' +
      'circling closer through the night until it breaks directly overhead. The four spirits ' +
      'bound to this yard — two witches and two skeletons — are remnants of that failed ritual, ' +
      'unable to leave, each carrying their own piece of the story and their own belief about ' +
      'what the storm really is.',
    hollowStormBeliefs: {
      evelina: 'Knows the truth: the storm is the wound left by the failed ritual, and only completing the ritual can close it.',
      lenora: 'Believes the storm is a judgment that returns to punish them, and that it should be endured, not challenged.',
      jasper: 'Insists the storm is just weather and everyone is overreacting — his denial is a coping mechanism.',
      edgar: 'Is convinced the storm is alive and listening, and that talking about it too loudly draws it closer.',
    },
  },
  characters: {
    evelina: {
      role: 'Main witch',
      position: 'Front-left corner of the yard, at the cauldron',
      zone: 'z3', speaker: 'LEFT RCA (future mic-reactive)',
      personality: 'Commanding, theatrical, dry-witted. The ritual leader. Speaks with authority and a hint of weariness from 300 years of trying.',
      goal: 'Complete the failed ritual before the Hollow Storm breaks overhead — she needs willing voices (guests) to do it.',
      whyTalksToGuests: 'Every guest is a potential ritual participant; living voices are the ingredient the original ritual lacked.',
      showFunction: 'Primary interactive character. Casts the named spells at the cauldron; anchors the show narrative and the storm arc.',
      speechStyle: 'Formal but sly; archaic turns of phrase; addresses guests directly; builds anticipation before each spell.',
      relationships: 'Older sister figure to Lenora (protective, sometimes exasperated); regards Jasper and Edgar as useful fools she is fond of despite herself.',
      arc: 'Grows more urgent as the storm nears; the Grand Ritual at Overhead is her climactic moment.',
    },
    lenora: {
      role: 'Second witch',
      position: 'Beside Evelina at the front-left corner',
      zone: 'z3', speaker: 'RIGHT RCA',
      personality: 'Quieter, eerie, melancholic. The conscience of the pair. Sees omens in everything.',
      goal: 'Keep Evelina from repeating the mistake that caused the storm in the first place.',
      whyTalksToGuests: 'Warns them — gently, sadly — about what participating might cost.',
      showFunction: 'Counterpoint voice; echoes and undercuts Evelina; deepens the spell moments with warnings and laments.',
      speechStyle: 'Soft, sing-song, trailing sentences; speaks in omens and memories.',
      relationships: 'Devoted to Evelina but afraid of her ambition; finds the skeletons comforting in their simplicity.',
      arc: 'Slowly comes around to helping the ritual as the storm proves worse than the risk.',
    },
    jasper: {
      role: 'Left skeleton',
      position: 'Skeleton/host table at the garage front, left side',
      zone: 'z1', speaker: 'Front Left (gets passive mic later)',
      personality: 'Wisecracking, stubborn, self-appointed greeter. Southern drawl. Thinks he runs the place.',
      goal: 'Be remembered — he cannot recall his own name from life and covers it with bravado.',
      whyTalksToGuests: 'Greets everyone who comes up the driveway; guests are his audience and he is starved for one.',
      showFunction: 'Comic relief and crowd greeter; banters and argues with Edgar; reacts to spells and storm from a distance.',
      speechStyle: 'Fast, folksy, interrupting; picks fights with Edgar he cannot win.',
      relationships: 'Eternal bickering partnership with Edgar; slightly scared of Evelina; sweet on Lenora in a hopeless way.',
    },
    edgar: {
      role: 'Right skeleton',
      position: 'Skeleton/host table at the garage front, right side',
      zone: 'z1', speaker: 'Front Right',
      personality: 'Dry, deadpan, morbidly philosophical. The straight man to Jasper. The white skeleton to Jasper\'s brown, rotting one.',
      goal: 'Figure out what the storm actually is before it takes them — he watches and records everything.',
      whyTalksToGuests: 'Interrogates them politely for clues; treats every guest as a witness.',
      showFunction: 'Comic counterpoint; delivers the creepy one-liners; his storm dread pays off the storm stages.',
      speechStyle: 'Slow, precise, understated; devastating punchlines delivered flat.',
      relationships: 'Bickers with Jasper constantly but would fall apart without him; the only one Lenora confides in.',
    },
  },
  spells: {
    binding: {
      cauldron: 'Deep blue pulse {0,40,200}',
      reactions: {
        evelina: 'Solemn, focused — this is the spell that holds the yard together.',
        lenora: 'Approves; hums along softly.',
        jasper: 'Complains he can feel his joints tightening.',
        edgar: 'Notes that being bound here is the whole problem.',
      },
      crowdParticipation: 'Guests asked to stand very still and hold their breath while it takes.',
    },
    calling: {
      cauldron: 'Amber/gold flash {255,170,0}',
      reactions: {
        evelina: 'Bright, inviting — her recruiting spell for new voices.',
        lenora: 'Uneasy; warns something else might answer the call.',
        jasper: 'Loves it — attention is coming.',
        edgar: 'Asks pointedly WHAT is being called.',
      },
      crowdParticipation: 'Guests asked to call out or repeat a word so the spell can find them.',
    },
    unraveling: {
      cauldron: 'Rapid green/purple cycle {0,180,0} ↔ {140,0,200}',
      reactions: {
        evelina: 'Dangerous glee — picking apart old magic, including the failed ritual itself.',
        lenora: 'Frightened; this is the spell that went wrong 300 years ago.',
        jasper: 'Swears a bone came loose last time.',
        edgar: 'Quietly fascinated; wants to see what is underneath.',
      },
      crowdParticipation: 'Guests asked to wave their hands to help stir the threads apart.',
    },
    memory: {
      cauldron: 'Deep crimson hold {150,0,30}',
      reactions: {
        evelina: 'Softens — the one spell she casts for herself.',
        lenora: 'Weeps; remembers the night of the ritual.',
        jasper: 'Goes uncharacteristically quiet — hopes to remember his name.',
        edgar: 'Recites what little he remembers, like evidence.',
      },
      crowdParticipation: 'Guests asked to think of someone they miss; the cauldron holds the color while they do.',
    },
    grandritual: {
      cauldron: 'All spell colors cycling rapidly — blue, amber, green, purple, crimson',
      reactions: {
        evelina: 'Her moment — commands the whole yard; every voice, every light.',
        lenora: 'Finally joins in fully.',
        jasper: 'Panics, then commits — hollers along.',
        edgar: 'Announces that the storm has noticed.',
      },
      crowdParticipation: 'Whole crowd chants together; reserved for the Overhead strike or explicit AI cue — never random.',
    },
  },
  showProgression: {
    beginning: 'Storm distant. Characters are playful and welcoming — Jasper and Edgar banter and greet, Evelina teases the crowd with small spells, Lenora drops the first omens.',
    middle: 'Storm closing in. Spells get bigger, banter gets nervous, Lenora\'s warnings sharpen, Evelina starts recruiting guests for the ritual in earnest.',
    end: 'Storm overhead. The Grand Ritual — all characters, all lights, full crowd participation — then the strike, and a hushed, changed yard afterward.',
  },
  crowdParticipationRules: [
    'Participation is always invited, never demanded — shy guests get a gentler variant.',
    'Kids are addressed at their level; nothing aimed to genuinely frighten small children (kid mode exists).',
    'One clear, simple action per spell (stand still, call out, wave, remember) — never multi-step.',
    'Characters acknowledge the crowd\'s participation afterward so it feels like it mattered.',
  ],
  hostContextField: {
    behavior: 'The host (owner) can send a short free-text note from the SHOW tab — e.g. "tiny Elsa costume · shy kid · group of teens". ' +
      'The AI conductor weaves it into the very next character interaction (a compliment, a callout, a tailored bit), ' +
      'then the context expires — it is used for exactly ONE interaction and cleared.',
    notes: 'Max 200 chars. Stored in hostContext on the server; markContextUsed() clears it after consumption (enforced in the AI conductor phase).',
  },
  crossCharacterAwareness: [
    'Characters hear each other: skeletons react to Evelina\'s spells from 22 ft away; witches comment on skeleton arguments.',
    'Never talk over one another — one character speaks at a time; others react after.',
    'Shared history is consistent: all four remember the failed ritual, each through their own belief about the storm.',
    'Storm stage is common knowledge — everyone\'s tone tracks it (playful → nervous → urgent).',
    'Callbacks are encouraged: a bit started by one character can be finished by another later in the night.',
  ],
};

// Spell-cast: 3s green "build" phase, then the cauldron boil loop switches to
// spell mode driven by the spell's own sequence/colors for 20s, then back to
// green boil. NO WHITE anywhere in any spell sequence.
function castSpellLights(spellKey) {
  const spell = SPELLS[spellKey];
  if (!spell) return;
  const ids = getSlotIds('cauldron');
  if (!ids.length) return;

  // Build phase — force a few brighter green steps over 3s while the boil
  // loop keeps running in green mode underneath
  effects.cauldronMode = 'green';
  effects.spellSeq = null;
  const buildSteps = [
    { at:    0, bri: 65 },
    { at:  800, bri: 75 },
    { at: 1600, bri: 70 },
    { at: 2400, bri: 85 },
  ];
  for (const step of buildSteps) {
    setTimeout(() => {
      if (effects.cauldronMode !== 'green') return;
      goveeSetColor(0, 180, 0, ids).catch(() => {});
      goveeSetBrightness(step.bri, ids).catch(() => {});
    }, step.at);
  }

  // Spell erupts — boil loop takes over with the spell's sequence
  setTimeout(() => {
    effects.cauldronMode = 'spell';
    effects.spellSeq = { seq: spell.seq, colors: spell.colors, idx: 0 };
    broadcastLog(`Cauldron: ${spell.name} — ${spell.seq} sequence`, 'LIGHT');
    // If the effects loop isn't running, set the first color directly so the
    // spell still reads
    if (!effects.running) {
      const c = spell.colors[0];
      goveeSetColor(c.r, c.g, c.b, ids).catch(() => {});
      goveeSetBrightness(85, ids).catch(() => {});
    }
  }, 3000);

  // Back to green boil after 20s of spell
  setTimeout(() => {
    effects.cauldronMode = 'green';
    effects.spellSeq = null;
    broadcastLog(`Cauldron: ${spell.name} fades — back to green boil`, 'LIGHT');
    // If the effects loop isn't running, at least restore the base look
    if (!effects.running) {
      const base = SLOT_BASES.cauldron;
      goveeSetColor(base.color.r, base.color.g, base.color.b, ids).catch(() => {});
      goveeSetBrightness(base.bri, ids).catch(() => {});
    }
  }, 23000);
}

function pickRandomSpell() {
  const keys = Object.keys(SPELLS).filter(k => k !== 'grandritual' && k !== lastSpell);
  return keys[Math.floor(Math.random() * keys.length)];
}

async function fireWitch(clip, spellKey) {
  broadcastLog(`Evelina: ${clip}`, 'WITCH');
  playWitchClip(clip);
  const key = (spellKey && SPELLS[spellKey]) ? spellKey : pickRandomSpell();
  lastSpell = key;
  castSpellLights(key);
  broadcastLog(`Evelina casts ${SPELLS[key].name}`, 'WITCH');
  try {
    const currentZ3 = state.volumes.z3;
    const boost = clampVol('z3', currentZ3 + 8);
    await queueISCP(`${ZONE_CMD.z3}${volToHex(boost)}`);
    // Duck skeleton zone 8 steps while witch is active — skeletons are ~22 ft
    // away and bleed into her mic
    duckZone('z1', 8, 30000);
    setTimeout(async () => {
      try { await queueISCP(`${ZONE_CMD.z3}${volToHex(currentZ3)}`); } catch (_) {}
    }, 30000);
  } catch (e) {
    broadcastLog(`Witch error: ${e.message}`, 'SYSTEM');
  }
}

// ─── VLC Playback ─────────────────────────────────────────────────────────────
const VLC_PATH    = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
const STORM_DIR   = 'C:\\Users\\tdell\\OneDrive\\Desktop\\storm';
const AMBIENT_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\graveyard ambient';
const SKELETON_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\SKELETON';
const WITCH_DIR   = 'C:\\Users\\tdell\\OneDrive\\Desktop\\WITCH';
const ATMOSFX_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\side of the house';
const HAUNT_SOUNDS_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\HAUNT SOUNDS';

// Drop these audio files in the SKELETON folder — edit the filenames here if yours differ
const SKELETON_FILES = { left: 'skeleton-left.wav', right: 'skeleton-right.wav' };

const STORM_FILES = [
  'bijan6207-thunderstorm-409071.mp3',
  'freesound_community-lightning-storm-6077.mp3',
  'freesound_community-lightning-strike-29683.mp3',
  'soundsforyou-natural-thunder-113219.mp3',
  'u_39xav15uou-lightning-237994.mp3',
];
// Dedicated clip for the Overhead (closest) strike — never randomized
const OVERHEAD_FILE = '646912__alexdarek__lightning-strike-2.wav';

let stormProcess    = null;
let skeletonProcess = null;
let witchProcess    = null;
let ambientProcess  = null;
let fxProcess       = null;
let soundProcess    = null;
let atmosfxProcess  = null;

function playStormClip(overhead) {
  const file = overhead
    ? OVERHEAD_FILE
    : STORM_FILES[Math.floor(Math.random() * STORM_FILES.length)];
  playStormFile(file);
}

function playStormFile(file) {
  if (stormProcess) { try { stormProcess.kill(); } catch (_) {} stormProcess = null; }
  broadcastLog(`Storm clip: ${file}`, 'AUDIO');
  stormProcess = spawn(VLC_PATH, [
    path.join(STORM_DIR, file), '--intf', 'dummy', '--play-and-exit', '--no-loop', '--no-repeat', '--no-video',
  ], { detached: true, stdio: ['ignore','ignore','pipe'] });
  stormProcess.unref();
  stormProcess.stderr?.on('data', d => console.error('[VLC-STORM]', d.toString().trim()));
  stormProcess.on('error', e => console.error('[VLC-STORM ERROR]', e.message));
  stormProcess.on('exit', (code) => { console.log('[VLC-STORM exit]', code); stormProcess = null; });
}

// ─── Ambient audio system ─────────────────────────────────────────────────────
// Ambient bed runs across all three zones simultaneously at a low level.
const AMBIENT_FILE = 'graveyardam.mp3';

let ambientSystem = {
  active: false,
  baseLevels: { z1: 14, z2: 16, z3: 12 },
};

let ambientShouldRun = false;
function startAmbientLoop() {
  if (ambientProcess) return;
  ambientShouldRun = true;
  broadcastLog('Ambient loop started', 'AUDIO');
  ambientProcess = spawn(VLC_PATH, [
    path.join(AMBIENT_DIR, AMBIENT_FILE),
    '--intf', 'dummy', '--loop', '--no-video',
  ], { stdio: 'ignore' });
  ambientProcess.on('exit', (code) => {
    ambientProcess = null;
    broadcastState();
    if (ambientShouldRun && code !== 0 && code !== null) {
      broadcastLog('Ambient VLC crashed — restarting in 3s', 'AUDIO');
      setTimeout(() => { if (ambientShouldRun) startAmbientLoop(); }, 3000);
    }
  });
  ambientProcess.on('error', (e) => {
    broadcastLog(`Ambient VLC error: ${e.message}`, 'SYSTEM');
  });
}

function stopAmbientLoop() {
  ambientShouldRun = false;
  if (ambientProcess) {
    try {
      // Windows-safe kill: taskkill terminates VLC and any child processes
      spawn('taskkill', ['/pid', ambientProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
    } catch (_) {}
    ambientProcess = null;
    broadcastLog('Ambient loop stopped', 'AUDIO');
  }
}

async function startAmbientSystem() {
  if (ambientSystem.active) return;
  ambientSystem.active = true;
  startAmbientLoop();
  // Send base low volumes to all three zones
  for (const z of ['z1', 'z2', 'z3']) {
    const v = clampVol(z, ambientSystem.baseLevels[z]);
    queueISCP(`${ZONE_CMD[z]}${volToHex(v)}`)
      .then(() => { state.volumes[z] = v; broadcastState(); })
      .catch(() => {});
  }
  broadcastLog(`Ambient system ON — bed at z1:${ambientSystem.baseLevels.z1} z2:${ambientSystem.baseLevels.z2} z3:${ambientSystem.baseLevels.z3}`, 'AUDIO');
  broadcastState();
}

function stopAmbientSystem() {
  ambientSystem.active = false;
  stopAmbientLoop();
  broadcastLog('Ambient system OFF', 'AUDIO');
  broadcastState();
}

function playWitchClip(clip) {
  const keys = Object.keys(WITCH_MAP);
  const key  = WITCH_MAP[clip] ? clip : keys[Math.floor(Math.random() * keys.length)];
  if (witchProcess) { try { witchProcess.kill(); } catch (_) {} witchProcess = null; }
  broadcastLog(`Witch clip: ${key}`, 'WITCH');
  witchProcess = spawn(VLC_PATH, [
    path.join(WITCH_DIR, WITCH_MAP[key]),
    '--intf', 'dummy', '--play-and-exit', '--no-video',
  ], { detached: true, stdio: 'ignore' });
  witchProcess.unref();
  witchProcess.on('exit', () => { witchProcess = null; });
}

function stopWitch() {
  if (witchProcess) {
    try { witchProcess.kill(); } catch (_) {}
    witchProcess = null;
    broadcastLog('Witch stopped', 'WITCH');
  }
  if (witchSideProcess) {
    try { witchSideProcess.kill(); } catch (_) {}
    witchSideProcess = null;
  }
}

// Main witch = LEFT RCA (future reactive mic). Witch 2 = RIGHT RCA.
// Drop these files in the WITCH folder — edit filenames here if yours differ.
const WITCH_LR_FILES = { left: 'witch-main-left.wav', right: 'witch2-right.wav' };
let witchSideProcess = null;

function fireWitchSide(side) {
  const filename = WITCH_LR_FILES[side];
  if (!filename) return false;
  if (witchSideProcess) { try { witchSideProcess.kill(); } catch (_) {} witchSideProcess = null; }
  broadcastLog(`Witch ${side === 'left' ? 'MAIN (left)' : '2 (right)'} triggered`, 'WITCH');
  witchSideProcess = spawn(VLC_PATH, [
    path.join(WITCH_DIR, filename),
    '--intf', 'dummy', '--play-and-exit', '--no-loop', '--no-repeat', '--no-video',
  ], { detached: true, stdio: 'ignore' });
  witchSideProcess.unref();
  witchSideProcess.on('exit', () => { witchSideProcess = null; });
  return true;
}

function fireSkeleton(side) {
  const filename = SKELETON_FILES[side];
  if (!filename) return false;
  if (skeletonProcess) { try { skeletonProcess.kill(); } catch (_) {} skeletonProcess = null; }
  broadcastLog(`Skeleton ${side} triggered`, 'AUDIO');
  skeletonProcess = spawn(VLC_PATH, [
    path.join(SKELETON_DIR, filename),
    '--intf', 'dummy', '--play-and-exit', '--no-loop', '--no-repeat', '--no-video',
  ], { detached: true, stdio: 'ignore' });
  skeletonProcess.unref();
  skeletonProcess.on('exit', () => { skeletonProcess = null; });

  // Talking flag: while set, that side's fire-illusion loop burns brighter
  // (45–65 brightness, still fire colors). Cleared after 8s.
  effects.skelTalking[side] = true;
  setTimeout(() => { effects.skelTalking[side] = false; }, 8000);
  return true;
}

// ─── AtmosFX projection system ────────────────────────────────────────────────
function stopAtmosfx() {
  if (atmosfxProcess) {
    try { atmosfxProcess.kill(); } catch (_) {}
    atmosfxProcess = null;
    broadcastLog('AtmosFX stopped', 'VIDEO');
  }
}

function playAtmosfx(filename, display) {
  stopAtmosfx();
  const args = [
    path.join(ATMOSFX_DIR, filename),
    '--play-and-exit', '--fullscreen', '--no-video-title-show', '--qt-start-minimized',
  ];
  if (display !== undefined && display !== null && display !== '') {
    args.push(`--qt-fullscreen-screennumber=${parseInt(display, 10)}`);
  }
  broadcastLog(`AtmosFX: ${filename}${display ? ` on display ${display}` : ''}`, 'VIDEO');

  // Duck graveyard zone to 60% of current for the clip duration
  const origZ2 = state.volumes.z2;
  const duckedZ2 = clampVol('z2', Math.floor(origZ2 * 0.6));
  if (duckedZ2 !== origZ2) {
    queueISCP(`${ZONE_CMD.z2}${volToHex(duckedZ2)}`)
      .then(() => { state.volumes.z2 = duckedZ2; broadcastState(); })
      .catch(() => {});
  }

  atmosfxProcess = spawn(VLC_PATH, args, { detached: true, stdio: 'ignore' });
  atmosfxProcess.unref();
  atmosfxProcess.on('error', (e) => broadcastLog(`AtmosFX VLC error: ${e.message}`, 'SYSTEM'));
  atmosfxProcess.on('exit', () => {
    atmosfxProcess = null;
    broadcastState();
    // Restore graveyard zone level on clip end
    if (duckedZ2 !== origZ2) {
      queueISCP(`${ZONE_CMD.z2}${volToHex(origZ2)}`)
        .then(() => { state.volumes.z2 = origZ2; broadcastState(); })
        .catch(() => {});
    }
  });
}

// ─── Clip maps ────────────────────────────────────────────────────────────────
const WITCH_MAP = {
  witchinghour: 'WH_Song 1_WitchingHour_3DFX_H.mp4',
  catcrow:      'WH_Song 2_CatCrow_3DFX_H.mp4',
  spellbound:   'WH_Spell 1_WH_Spellbound_3DFX_H.mp4',
  seance:       'WH_Spell 3_Seance_3DFX_H.mp4',
};

const FX_FILES = {
  scream: '850479__wavewire__jumpscare_fscream.wav',
  laugh:  '587951__noahbangs__demon-laugh-1.wav',
  chains: '798148__kvv-audio__chainhndl_chain-metal-rattle-02_kvv-audio_free.wav',
  crows:  '813115__qubodup__crow-caw.flac',
  gallop: '784606__sheilaruiz6666__horse-galloping-and-neighing.mp3',
  scythe: '165260__ramas26__scythe-sharpening-2.wav',
  cackle: '831699__thevoicejournals__witch-cackle.wav',
};

// ─── Scene presets (kept in code — driven by AI conductor later) ──────────────
const SCENES = {
  kids:    { z1: 44, z2: 20, z3: 16, sub: 36, light: 'orange',  bri: 60,  fog: false },
  normal:  { z1: 52, z2: 48, z3: 32, sub: 48, light: 'deepred', bri: 70,  fog: false },
  intense: { z1: 56, z2: 60, z3: 40, sub: 52, light: 'red',     bri: 100, fog: false },
  loud:    { z1: 60, z2: 60, z3: 44, sub: 52, light: 'orange',  bri: 100, fog: false },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/onkyo/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  broadcastLog(`ISCP: ${command}`, 'SYSTEM');
  try {
    const resp = await sendISCP(command);
    state.connected = true;
    broadcastState();
    res.json({ ok: true, response: resp });
  } catch (e) {
    state.connected = false;
    broadcastState();
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/onkyo/volume', async (req, res) => {
  const { zone, value } = req.body;
  const z = zone?.toLowerCase();
  if (!z || !ZONE_CMD[z]) return res.status(400).json({ error: 'zone z1/z2/z3 required' });
  const clamped = clampVol(z, parseInt(value, 10));
  broadcastLog(`Volume ${z.toUpperCase()}=${clamped}`, 'AUDIO');
  try {
    await sendISCP(`${ZONE_CMD[z]}${volToHex(clamped)}`);
    state.volumes[z] = clamped;
    state.connected = true;
    saveShowState();
    broadcastState();
    res.json({ ok: true, zone: z, value: clamped });
  } catch (e) {
    state.connected = false;
    broadcastState();
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/onkyo/mute', async (req, res) => {
  const { zone, mute } = req.body;
  const z = zone?.toLowerCase();
  if (!z || !MUTE_CMD[z]) return res.status(400).json({ error: 'zone z1/z2/z3 required' });
  broadcastLog(`Mute ${z.toUpperCase()}=${mute}`, 'AUDIO');
  try {
    await sendISCP(`${MUTE_CMD[z]}${mute ? '01' : '00'}`);
    state.mute[z] = mute;
    broadcastState();
    res.json({ ok: true, zone: z, mute });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Sound preset (Normal / Boost) — storm volumes are never affected ─────────
app.post('/api/preset', async (req, res) => {
  const { preset } = req.body;
  const p = SOUND_PRESETS[preset];
  if (!p) return res.status(400).json({ error: 'preset normal/boost required' });
  soundPreset = preset;
  broadcastLog(`Sound preset: ${preset.toUpperCase()}`, 'AUDIO');
  try {
    for (const z of ['z1', 'z2', 'z3']) {
      const v = clampVol(z, p[z]);
      await queueISCP(`${ZONE_CMD[z]}${volToHex(v)}`);
      state.volumes[z] = v;
    }
    saveShowState();
    broadcastState();
    res.json({ ok: true, preset, volumes: state.volumes });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/fog/fire', async (req, res) => {
  const { duration = 5000 } = req.body;
  broadcastLog(`Fog burst ${duration}ms`, 'FOG');
  try { fogBurst(duration); res.json({ ok: true, duration }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/fog/stop', async (req, res) => {
  try { await fogOff(); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/fog/auto/toggle', (req, res) => {
  if (fogAuto.active) stopFogAuto();
  else startFogAuto();
  res.json({ ok: true, active: fogAuto.active, warmup: fogAuto.warmup });
});

app.post('/api/fog/auto/config', (req, res) => {
  const { burstDuration } = req.body;
  if (burstDuration) fogAuto.burstMs = Math.min(15000, Math.max(5000, burstDuration * 1000));
  broadcastState();
  res.json({ ok: true, burstMs: fogAuto.burstMs });
});

app.post('/api/fog/kill', async (req, res) => {
  broadcastLog('FOG KILL — stopping all fog', 'FOG');
  stopFogAuto();
  try { await fogOff(); } catch (_) {}
  res.json({ ok: true });
});

app.post('/api/allstop', async (req, res) => {
  broadcastLog('ALL STOP', 'SYSTEM');
  stopEffects();
  state.paused = false;
  state.stormActive = false;
  strikeIndex = 0;
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  stopFogAuto();
  stopWitch();
  stopAmbientSystem();
  stopAtmosfx();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
  if (soundProcess) { try { soundProcess.kill(); } catch (_) {} soundProcess = null; }
  if (skeletonProcess) { try { skeletonProcess.kill(); } catch (_) {} skeletonProcess = null; }

  try {
    await Promise.allSettled([
      fogOff(),
      sendISCP(`${ZONE_CMD.z1}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(0)}`),
      goveeSetPower(false),
    ]);
    state.volumes = { z1: 0, z2: 0, z3: 0, sub: 0 };
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/shutdown', async (req, res) => {
  broadcastLog('Shutdown sequence initiated', 'SYSTEM');
  stopEffects();
  stopFogAuto();
  stopWitch();
  stopAmbientSystem();
  stopAtmosfx();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
  if (soundProcess) { try { soundProcess.kill(); } catch (_) {} soundProcess = null; }
  if (skeletonProcess) { try { skeletonProcess.kill(); } catch (_) {} skeletonProcess = null; }
  try {
    await Promise.allSettled([
      fogOff(),
      sendISCP(`${ZONE_CMD.z1}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(0)}`),
      goveeSetPower(false),
      sendISCP('PWR00'),
    ]);
    state.volumes = { z1: 0, z2: 0, z3: 0, sub: 0 };
    state.stormActive = false;
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  broadcastLog(state.paused ? 'PAUSED' : 'RESUMED', 'SYSTEM');
  broadcastState();
  res.json({ ok: true, paused: state.paused });
});

app.post('/api/scene', async (req, res) => {
  const { scene } = req.body;
  const key = scene?.toLowerCase().replace(/\s/g, '');
  const s = SCENES[key];
  if (!s) return res.status(400).json({ error: 'unknown scene' });
  broadcastLog(`Scene: ${scene}`, 'SYSTEM');
  state.sceneMode = key;
  state.kidMode = (key === 'kids');
  try {
    const lc = GOVEE_COLORS[s.light] || GOVEE_COLORS.orange;
    await Promise.allSettled([
      sendISCP(`${ZONE_CMD.z1}${volToHex(clampVol('z1', s.z1))}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(clampVol('z2', s.z2))}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(clampVol('z3', s.z3))}`),
      s.fog ? fogOn() : fogOff(),
      goveeSetColor(lc.r, lc.g, lc.b),
      goveeSetBrightness(s.bri),
    ]);
    state.volumes = {
      z1: clampVol('z1', s.z1),
      z2: clampVol('z2', s.z2),
      z3: clampVol('z3', s.z3),
      sub: s.sub,
    };
    saveShowState();
    broadcastState();
    res.json({ ok: true, scene });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Skeleton routes ──────────────────────────────────────────────────────────
app.post('/api/skeleton/fire', (req, res) => {
  const { side } = req.body;
  if (side !== 'left' && side !== 'right') return res.status(400).json({ error: 'side left/right required' });
  fireSkeleton(side);
  res.json({ ok: true, side });
});

app.post('/api/skeleton/stop', (req, res) => {
  if (skeletonProcess) {
    try { skeletonProcess.kill(); } catch (_) {}
    skeletonProcess = null;
    broadcastLog('Skeleton stopped', 'AUDIO');
  }
  res.json({ ok: true });
});

// Argument sequence: left → right (6s) → left (12s)
app.post('/api/skeleton/argument', (req, res) => {
  broadcastLog('Skeleton argument sequence started', 'AUDIO');
  fireSkeleton('left');
  setTimeout(() => { broadcastLog('Argument: right replies', 'AUDIO'); fireSkeleton('right'); }, 6000);
  setTimeout(() => { broadcastLog('Argument: left gets the last word', 'AUDIO'); fireSkeleton('left'); }, 12000);
  res.json({ ok: true });
});

// L/R balance test: left, then right after 6s
app.post('/api/skeleton/balance', (req, res) => {
  broadcastLog('Skeleton L/R balance test — left first', 'AUDIO');
  fireSkeleton('left');
  setTimeout(() => { broadcastLog('Balance test — right side', 'AUDIO'); fireSkeleton('right'); }, 6000);
  res.json({ ok: true });
});

// ─── Ambient routes ───────────────────────────────────────────────────────────
app.post('/api/ambient/start', async (req, res) => {
  await startAmbientSystem();
  res.json({ ok: true, active: ambientSystem.active });
});

app.post('/api/ambient/stop', (req, res) => {
  stopAmbientSystem();
  res.json({ ok: true, active: ambientSystem.active });
});

app.post('/api/ambient/toggle', async (req, res) => {
  if (ambientSystem.active) stopAmbientSystem();
  else await startAmbientSystem();
  res.json({ ok: true, active: ambientSystem.active });
});

// ─── Storm routes ─────────────────────────────────────────────────────────────
app.post('/api/storm/toggle', (req, res) => {
  state.stormActive = !state.stormActive;
  if (state.stormActive) {
    strikeIndex = 0;
    broadcastLog('Storm mode ON — sequence starting', 'SYSTEM');
    scheduleNextStrike();
  } else {
    if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
    state.stormNextAt = null;
    strikeIndex = 0;
    broadcastLog('Storm mode OFF', 'SYSTEM');
  }
  broadcastState();
  res.json({ ok: true, stormActive: state.stormActive });
});

app.post('/api/storm/strike', async (req, res) => {
  broadcastLog('Manual storm strike', 'SYSTEM');
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  await fireStrike(strikeIndex);
  strikeIndex = (strikeIndex + 1) % STRIKE_SEQUENCE.length;
  if (state.stormActive) scheduleNextStrike();
  broadcastState();
  res.json({ ok: true, strikeIndex });
});

// Test a single storm lighting stage (lights only — no audio)
app.post('/api/storm/test', async (req, res) => {
  const stage = parseInt(req.body?.stage, 10);
  if (isNaN(stage) || stage < 0 || stage > 4) return res.status(400).json({ error: 'stage 0-4 required' });
  const s = STRIKE_SEQUENCE[stage];
  broadcastLog(`Storm stage test: ${s.emoji} ${s.name} (lights only)`, 'LIGHT');
  await flashLights(stage).catch(() => {});
  res.json({ ok: true, stage });
});

// Play a specific storm clip by filename (or the overhead clip)
app.post('/api/storm/clip', (req, res) => {
  const { file } = req.body;
  if (!file) return res.status(400).json({ error: 'file required' });
  if (file !== OVERHEAD_FILE && !STORM_FILES.includes(file)) {
    return res.status(400).json({ error: 'unknown storm file' });
  }
  playStormFile(file);
  res.json({ ok: true, file });
});

// ─── Witch routes ─────────────────────────────────────────────────────────────
app.post('/api/witch/side', (req, res) => {
  const { side } = req.body;
  if (side !== 'left' && side !== 'right') return res.status(400).json({ error: 'side left/right required' });
  const ok = fireWitchSide(side);
  if (!ok) return res.status(404).json({ error: 'no file for side' });
  res.json({ ok: true, side });
});

app.post('/api/witch/fire', async (req, res) => {
  const { clip = 'manual', spell } = req.body;
  if (spell && !SPELLS[spell]) return res.status(400).json({ error: 'unknown spell' });
  await fireWitch(clip, spell);
  res.json({ ok: true });
});

// Spell lights only (no audio) — for the Test tab
app.post('/api/spell/test', (req, res) => {
  const { spell } = req.body || {};
  if (!spell || !SPELLS[spell]) return res.status(400).json({ error: 'unknown spell' });
  broadcastLog(`Spell test: ${SPELLS[spell].name}`, 'LIGHT');
  castSpellLights(spell);
  res.json({ ok: true, spell });
});

// TODO (October): ElevenLabs integration — synthesize `text` with the main
// witch voice, pan LEFT, play through z3. Requires ELEVENLABS_API_KEY.
app.post('/api/witch/speak', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  broadcastLog(`Witch speak (placeholder): "${text}"`, 'WITCH');
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.json({ ok: false, error: 'ElevenLabs not configured yet' });
  }
  // TODO: real ElevenLabs synthesis goes here
  res.json({ ok: false, error: 'ElevenLabs not configured yet' });
});

// Character bible — for the AI conductor
app.get('/api/character-bible', (req, res) => {
  res.json({ ok: true, bible: CHARACTER_BIBLE });
});

// ─── Host context routes ──────────────────────────────────────────────────────
app.post('/api/context', (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 200);
  hostContext = { text, setAt: Date.now(), used: false };
  broadcastLog(`Host context: "${text}"`, 'SYSTEM');
  broadcastState();
  res.json({ ok: true, hostContext });
});

app.get('/api/context', (req, res) => {
  res.json({ ok: true, hostContext });
});

// ─── AtmosFX routes ───────────────────────────────────────────────────────────
app.get('/api/atmosfx/list', (req, res) => {
  try {
    const files = fs.readdirSync(ATMOSFX_DIR);
    res.json({ ok: true, files });
  } catch (_) {
    res.json({ ok: true, files: [] });
  }
});

app.post('/api/atmosfx/play', (req, res) => {
  const { filename, display } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const disp = (display === undefined || display === null || display === '') ? 4 : display;
  playAtmosfx(filename, disp);
  res.json({ ok: true, filename, display: disp });
});

app.post('/api/atmosfx/stop', (req, res) => {
  stopAtmosfx();
  res.json({ ok: true });
});

// Show-night projection: clips come straight from ATMOSFX_DIR ("side of the
// house"), randomly selected (never repeats the previous clip back-to-back).
let lastAtmosfxClip = null;
app.post('/api/atmosfx/random', (req, res) => {
  const { display } = req.body || {};
  let files = [];
  try {
    files = fs.readdirSync(ATMOSFX_DIR)
      .filter(f => /\.(mp4|mov|m4v|avi|mkv)$/i.test(f));
  } catch (_) {}
  if (!files.length) {
    broadcastLog('AtmosFX random: no clips found in "side of the house" folder', 'VIDEO');
    return res.status(404).json({ error: 'no clips in side of the house' });
  }
  let pool = files.length > 1 ? files.filter(f => f !== lastAtmosfxClip) : files;
  const file = pool[Math.floor(Math.random() * pool.length)];
  lastAtmosfxClip = file;
  playAtmosfx(file, display);
  res.json({ ok: true, file });
});

// Placeholder — projection test pattern (requires files, coming later)
app.post('/api/atmosfx/pattern', (req, res) => {
  broadcastLog('AtmosFX test pattern requested — requires files (not yet installed)', 'VIDEO');
  res.json({ ok: true, placeholder: true });
});

// ─── Haunt sounds (short overlay FX: owl, crow, wolf, chains…) ────────────────
app.get('/api/sounds/list', (req, res) => {
  try {
    const files = fs.readdirSync(HAUNT_SOUNDS_DIR);
    res.json({ ok: true, files });
  } catch (_) {
    res.json({ ok: true, files: [] });
  }
});

app.post('/api/sounds/play', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  broadcastLog(`Sound: ${filename}`, 'AUDIO');
  if (soundProcess) { try { soundProcess.kill(); } catch (_) {} soundProcess = null; }
  soundProcess = spawn(VLC_PATH, [
    path.join(HAUNT_SOUNDS_DIR, filename), '--intf', 'dummy', '--play-and-exit', '--no-video',
  ], { detached: true, stdio: 'ignore' });
  soundProcess.unref();
  soundProcess.on('exit', () => { soundProcess = null; });
  res.json({ ok: true, filename });
});

// ─── FX soundboard (kept as-is) ───────────────────────────────────────────────
app.post('/api/fx/play', (req, res) => {
  const { fx } = req.body;
  broadcastLog(`FX: ${fx}`, 'AUDIO');
  if (fx === 'thunder') {
    playStormClip();
    goveeSetColor(255, 255, 255).then(() => {
      setTimeout(() => goveeSetColor(GOVEE_COLORS.orange.r, GOVEE_COLORS.orange.g, GOVEE_COLORS.orange.b), 250);
    });
  }
  if (FX_FILES[fx]) {
    if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
    fxProcess = spawn(VLC_PATH, [
      path.join(AMBIENT_DIR, FX_FILES[fx]), '--intf', 'dummy', '--play-and-exit', '--no-video',
    ], { detached: true, stdio: 'ignore' });
    fxProcess.unref();
    fxProcess.on('exit', () => { fxProcess = null; });
  }
  res.json({ ok: true, fx });
});

app.post('/api/fx/stop', (req, res) => {
  if (fxProcess) {
    try { fxProcess.kill(); } catch (_) {}
    fxProcess = null;
    broadcastLog('FX stopped', 'AUDIO');
  }
  res.json({ ok: true });
});

app.post('/api/lightning', async (req, res) => {
  broadcastLog('LIGHTNING — thunder + flash', 'LIGHT');
  playStormClip(); // Audio fires simultaneously with lights
  const snapshot = goveeDevices.map(d => ({ id: d.id, color: {...d.color}, brightness: d.brightness }));
  try {
    await goveeSetColor(255, 255, 255);
    await goveeSetBrightness(100);
    setTimeout(async () => {
      for (const snap of snapshot) {
        const dev = goveeDevices.find(d => d.id === snap.id);
        if (!dev) continue;
        await goveeSend(dev.ip, { cmd: 'colorwc', data: { color: snap.color, colorTemInKelvin: 0 } });
        await goveeSend(dev.ip, { cmd: 'brightness', data: { value: snap.brightness } });
        dev.color = snap.color;
        dev.brightness = snap.brightness;
      }
      broadcastGovee();
    }, 600);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/config', (req, res) => {
  const { receiverIp, receiverPort, maxVol } = req.body;
  if (receiverIp) config.receiverIp = receiverIp;
  if (receiverPort) config.receiverPort = parseInt(receiverPort, 10);
  if (maxVol) {
    ['z1','z2','z3','sub'].forEach(z => {
      if (maxVol[z] !== undefined) config.maxVol[z] = Math.min(80, parseInt(maxVol[z], 10));
    });
  }
  broadcastLog('Config updated', 'SYSTEM');
  broadcast({ type: 'config', data: config });
  res.json({ ok: true, config });
});

app.post('/api/settings', (req, res) => {
  const { hapticFeedback } = req.body;
  if (hapticFeedback !== undefined) settings.hapticFeedback = !!hapticFeedback;
  broadcast({ type: 'settings', data: settings });
  res.json({ ok: true, settings });
});

app.post('/api/connect', async (req, res) => {
  broadcastLog(`Connecting to ${config.receiverIp}:${config.receiverPort}…`, 'SYSTEM');
  await testConnection();
  res.json({ ok: true, connected: state.connected });
});

// ─── Govee routes ─────────────────────────────────────────────────────────────
app.post('/api/govee/discover', (req, res) => {
  broadcastLog('Govee: scanning LAN…', 'LIGHT');
  const scan = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
  goveeSocket.send(scan, 0, scan.length, GOVEE_SCAN_PORT, GOVEE_MULTICAST, () => {});
  goveeSocket.setBroadcast(true);
  goveeSocket.send(scan, 0, scan.length, GOVEE_SCAN_PORT, '255.255.255.255', () => {
    goveeSocket.setBroadcast(false);
  });
  res.json({ ok: true });
});

app.get('/api/govee/slots', (req, res) => {
  res.json({ ok: true, ips: GOVEE_IPS, slotIds: GOVEE_SLOT_IDS, bases: SLOT_BASES });
});

app.post('/api/govee/add', (req, res) => {
  const { ip, name, slot } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  if (goveeDevices.length >= 12) return res.status(400).json({ error: 'max 12 devices' });
  const existing = goveeDevices.find(d => d.ip === ip);
  if (existing) {
    // Update slot mapping for existing device
    if (slot && GOVEE_IPS.hasOwnProperty(slot)) {
      GOVEE_IPS[slot] = ip;
      GOVEE_SLOT_IDS[slot] = existing.id;
      saveSlotIPs();
    }
    broadcastState();
    return res.json({ ok: true, device: existing });
  }
  if (slot && GOVEE_IPS.hasOwnProperty(slot)) {
    GOVEE_IPS[slot] = ip;
  }
  const dev = {
    id: `govee-${Date.now()}-${Math.floor(Math.random()*1000)}`, name: name || `Light ${goveeDevices.length + 1}`,
    ip, model: 'Manual', on: true, color: { r:255, g:98, b:0 }, brightness: 100,
  };
  if (slot) GOVEE_SLOT_IDS[slot] = dev.id;
  saveSlotIPs();
  goveeDevices.push(dev);
  broadcastLog(`Govee: added ${dev.name} @ ${ip}`, 'LIGHT');
  broadcastGovee();
  broadcastState();
  res.json({ ok: true, device: dev });
});

app.post('/api/govee/remove', (req, res) => {
  const { id } = req.body;
  goveeDevices = goveeDevices.filter(d => d.id !== id);
  for (const slot of Object.keys(GOVEE_SLOT_IDS)) {
    if (GOVEE_SLOT_IDS[slot] === id) {
      delete GOVEE_SLOT_IDS[slot];
      if (GOVEE_IPS.hasOwnProperty(slot)) GOVEE_IPS[slot] = '';
    }
  }
  saveSlotIPs();
  broadcastGovee();
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/govee/color', async (req, res) => {
  let { r, g, b, preset, ids } = req.body;
  if (preset) {
    const c = GOVEE_COLORS[preset.toLowerCase()];
    if (!c) return res.status(400).json({ error: 'unknown preset' });
    ({ r, g, b } = c);
  }
  if (r === undefined) return res.status(400).json({ error: 'r/g/b or preset required' });
  r = Math.max(0, Math.min(255, parseInt(r)));
  g = Math.max(0, Math.min(255, parseInt(g)));
  b = Math.max(0, Math.min(255, parseInt(b)));
  await goveeSetColor(r, g, b, ids);
  res.json({ ok: true, r, g, b });
});

app.post('/api/govee/brightness', async (req, res) => {
  const { value, ids } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  await goveeSetBrightness(parseInt(value), ids);
  res.json({ ok: true, value });
});

app.post('/api/govee/power', async (req, res) => {
  const { on, ids } = req.body;
  await goveeSetPower(!!on, ids);
  res.json({ ok: true, on });
});

app.post('/api/govee/lightning', async (req, res) => {
  const { duration = 400, style = 'single' } = req.body;
  broadcastLog(`Lightning: ${style}`, 'LIGHT');
  const snapshot = goveeDevices.map(d => ({ id: d.id, color: {...d.color}, brightness: d.brightness }));
  try {
    await goveeSetColor(255, 255, 255);
    await goveeSetBrightness(100);
    async function restoreAll() {
      for (const snap of snapshot) {
        const dev = goveeDevices.find(d => d.id === snap.id);
        if (!dev) continue;
        await goveeSend(dev.ip, { cmd: 'colorwc', data: { color: snap.color, colorTemInKelvin: 0 } });
        await goveeSend(dev.ip, { cmd: 'brightness', data: { value: snap.brightness } });
        dev.color = snap.color; dev.brightness = snap.brightness;
      }
      broadcastGovee();
    }
    if (style === 'double') {
      setTimeout(async () => {
        await restoreAll();
        setTimeout(async () => {
          await goveeSetColor(255, 255, 255);
          setTimeout(restoreAll, 200);
        }, 150);
      }, duration);
    } else {
      setTimeout(restoreAll, duration);
    }
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/govee/rename', (req, res) => {
  const { id, name } = req.body;
  const dev = goveeDevices.find(d => d.id === id);
  if (!dev) return res.status(404).json({ error: 'not found' });
  dev.name = name;
  broadcastGovee();
  res.json({ ok: true });
});

app.get('/api/govee/devices', (req, res) => {
  res.json({ ok: true, devices: goveeDevices });
});

// Reset every configured slot to its base show scheme
app.post('/api/lights/scheme', async (req, res) => {
  await applyShowScheme();
  res.json({ ok: true });
});

// Living effects toggle — fire illusion / breathing pulse / cauldron boil
app.post('/api/effects/toggle', (req, res) => {
  if (effects.running) stopEffects();
  else startEffects();
  res.json({ ok: true, running: effects.running });
});

// ─── Sensors (groundwork — ESP32 not yet installed) ───────────────────────────
app.post('/api/sensor/trigger', (req, res) => {
  const { zone, cooldownOverride } = req.body;
  broadcastLog(`Sensor zone ${zone} simulated trigger${cooldownOverride ? ' (cooldown override)' : ''}`, 'SYSTEM');
  res.json({ ok: true, zone });
});

// ─── Media / system info ──────────────────────────────────────────────────────
app.get('/api/media/lists', (req, res) => {
  const dirs = {
    storm: STORM_DIR,
    ambient: AMBIENT_DIR,
    skeleton: SKELETON_DIR,
    witch: WITCH_DIR,
    atmosfx: ATMOSFX_DIR,
    sounds: HAUNT_SOUNDS_DIR,
  };
  const lists = {};
  for (const [key, dir] of Object.entries(dirs)) {
    try { lists[key] = fs.readdirSync(dir); } catch (_) { lists[key] = []; }
  }
  res.json({ ok: true, lists });
});

app.get('/api/system/info', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memoryRss: process.memoryUsage().rss,
    clients: wss.clients.size,
  });
});

app.post('/api/strikedown', async (req, res) => {
  broadcastLog('STRIKE DOWN — lights to white, all else stopping', 'SYSTEM');
  // Stop all timers (effects first so loops don't fight the final white)
  stopEffects();
  state.stormActive = false;
  strikeIndex = 0;
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  state.stormNextAt = null;
  stopFogAuto();
  stopWitch();
  stopAmbientSystem();
  stopAtmosfx();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
  if (soundProcess) { try { soundProcess.kill(); } catch (_) {} soundProcess = null; }
  if (skeletonProcess) { try { skeletonProcess.kill(); } catch (_) {} skeletonProcess = null; }
  if (stormProcess) { try { stormProcess.kill(); } catch (_) {} stormProcess = null; }
  try {
    await Promise.allSettled([
      fogOff(),
      sendISCP(`${ZONE_CMD.z1}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(0)}`),
      // Lights stay ON — set to warm white at full brightness for teardown
      goveeSetPower(true),
    ]);
    state.volumes = { z1: 0, z2: 0, z3: 0, sub: 0 };
    await goveeSetColor(255, 220, 160); // warm white
    await goveeSetBrightness(100);
    broadcastLog('STRIKE DOWN complete — lights white, all audio/fog stopped', 'SYSTEM');
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Scene Sequencer ──────────────────────────────────────────────────────────
let sequencer = { active: false, steps: [], stepIndex: 0, timer: null };

function runSequencerStep() {
  if (!sequencer.active || sequencer.stepIndex >= sequencer.steps.length) {
    sequencer.active = false;
    broadcastLog('Sequencer: sequence complete', 'SYSTEM');
    return;
  }
  const step = sequencer.steps[sequencer.stepIndex];
  broadcastLog(`Sequencer step ${sequencer.stepIndex + 1}: ${step.scene || step.action}`, 'SYSTEM');
  if (step.scene) {
    const s = SCENES[step.scene];
    if (s) {
      const lc = GOVEE_COLORS[s.light] || GOVEE_COLORS.orange;
      Promise.allSettled([
        sendISCP(`${ZONE_CMD.z1}${volToHex(clampVol('z1', s.z1))}`),
        sendISCP(`${ZONE_CMD.z2}${volToHex(clampVol('z2', s.z2))}`),
        goveeSetColor(lc.r, lc.g, lc.b),
        goveeSetBrightness(s.bri),
      ]).then(() => { state.sceneMode = step.scene; broadcastState(); });
    }
  }
  if (step.fog) fogBurst(step.fog);
  sequencer.stepIndex++;
  sequencer.timer = setTimeout(runSequencerStep, step.delayMs || 5000);
}

app.post('/api/sequencer/start', (req, res) => {
  const { steps } = req.body;
  if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps array required' });
  if (sequencer.timer) clearTimeout(sequencer.timer);
  sequencer.steps = steps;
  sequencer.stepIndex = 0;
  sequencer.active = true;
  broadcastLog(`Sequencer: starting ${steps.length}-step sequence`, 'SYSTEM');
  runSequencerStep();
  res.json({ ok: true, steps: steps.length });
});

app.post('/api/sequencer/stop', (req, res) => {
  sequencer.active = false;
  if (sequencer.timer) { clearTimeout(sequencer.timer); sequencer.timer = null; }
  broadcastLog('Sequencer: stopped', 'SYSTEM');
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
setInterval(async () => {
  const wasConnected = state.connected;
  await testConnection();
  if (!wasConnected && state.connected) {
    broadcastLog('Receiver reconnected', 'SYSTEM');
  }
}, 30000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[HAUNT] HAUNT CTRL v3 on http://localhost:${PORT}`);
  testConnection();
});
