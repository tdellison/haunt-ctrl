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
  autoDuckSkeleton: true,
  fogWithCharacters: true,
  hapticFeedback: true,
};

// ─── Govee Devices ────────────────────────────────────────────────────────────
let goveeDevices = [];
const GOVEE_IPS = {
  graveyard: '',
  witch: '',
  skeleton: '',
  tree: '',
};
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
      if (!goveeDevices.find(d => d.ip === ip) && goveeDevices.length < 8) {
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

// Return Govee device IDs for named slots
function getSlotIds(...slots) {
  return slots.map(s => GOVEE_SLOT_IDS[s]).filter(Boolean);
}

// Flash lights: storm-only or all-lights, with brightness level
async function flashLights(style, allLights) {
  const snapshot = goveeDevices.map(d => ({ id: d.id, color: {...d.color}, brightness: d.brightness }));
  const bri = style === 'dim' ? 25 : style === 'medium' ? 60 : 100;
  const holdMs = style === 'all-blast' ? 600 : style === 'all-medium' ? 400 : 250;
  await goveeSetColor(255, 255, 255);
  await goveeSetBrightness(bri);

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
  }, holdMs);
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
  autoScare: {
    active:      false,
    intervalMin: 2,
    chars:       { grimreaper: true, headlesshorseman: true, pumpkinking: true },
    lastChar:    null,
    timer:       null,
    nextAt:      null,
  },
  witchTimer: {
    active: false,
    timer:  null,
    nextAt: null,
  },
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
    console.log('[HAUNT] Show state restored from disk');
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
    autoScare: {
      active:      state.autoScare.active,
      intervalMin: state.autoScare.intervalMin,
      chars:       state.autoScare.chars,
      nextAt:      state.autoScare.nextAt,
    },
    witchTimer: {
      active: state.witchTimer.active,
      nextAt: state.witchTimer.nextAt,
    },
    graveyardCycle: { active: graveyardCycle.active },
  };
}

loadShowState();

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
const STRIKE_SEQUENCE = [
  { name: 'Distant',       emoji: '🌧', z2Vol: 48, fog: false, flash: 'dim',        allLights: false },
  { name: 'Getting Closer',emoji: '⛈', z2Vol: 46, fog: false, flash: 'medium',     allLights: false },
  { name: 'Close',         emoji: '🌩', z2Vol: 42, fog: false, flash: 'bright',     allLights: false },
  { name: 'Very Close',    emoji: '⚡', z2Vol: 38, fog: false, flash: 'all-medium', allLights: true  },
  { name: 'Overhead',      emoji: '💥', z2Vol: 36, fog: true,  flash: 'all-blast',  allLights: true  },
];

const STRIKE_INTERVAL_MS = 120000; // 2 minutes

let strikeIndex = 0;

async function fireStrike(idx) {
  const s = STRIKE_SEQUENCE[idx];
  broadcastLog(`Storm ${idx + 1}/5 — ${s.emoji} ${s.name}`, 'AUDIO');
  playStormClip(s.name === 'Overhead');

  try {
    const z2 = clampVol('z2', s.z2Vol);
    await sendISCP(`${ZONE_CMD.z2}${volToHex(z2)}`);
    state.volumes.z2 = z2;
    broadcastState();

    if (s.fog) fogBurst(5000);

    const delay = 1200 + Math.random() * 800;
    setTimeout(() => {
      broadcastLog(`Storm: lightning flash [${s.flash}]`, 'LIGHT');
      flashLights(s.flash, s.allLights).catch(() => {});
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

// ─── Auto scare engine ────────────────────────────────────────────────────────
const ALL_CHARS = ['grimreaper', 'headlesshorseman', 'pumpkinking'];

function pickNextChar() {
  const enabled = ALL_CHARS.filter(c => state.autoScare.chars[c]);
  if (enabled.length === 0) return null;
  const pool = enabled.filter(c => c !== state.autoScare.lastChar);
  return pool.length > 0
    ? pool[Math.floor(Math.random() * pool.length)]
    : enabled[Math.floor(Math.random() * enabled.length)];
}

function scheduleNextScare() {
  if (!state.autoScare.active) return;
  const ms = state.autoScare.intervalMin * 60000;
  state.autoScare.nextAt = Date.now() + ms;
  broadcastState();
  state.autoScare.timer = setTimeout(async () => {
    if (!state.autoScare.active || state.paused) return scheduleNextScare();
    const char = pickNextChar();
    if (char) {
      broadcastLog(`Auto Scare: firing ${char}`, 'SCARE');
      state.autoScare.lastChar = char;
      await fireCharacter(char);
    }
    scheduleNextScare();
  }, ms);
}

// ─── Witch timer ──────────────────────────────────────────────────────────────
function scheduleNextWitch() {
  if (!state.witchTimer.active) return;
  const ms = 120000 + Math.random() * 60000;
  state.witchTimer.nextAt = Date.now() + ms;
  broadcastState();
  state.witchTimer.timer = setTimeout(async () => {
    if (!state.witchTimer.active || state.paused) return scheduleNextWitch();
    broadcastLog('Witch timer: auto-fire', 'WITCH');
    await fireWitch('auto');
    scheduleNextWitch();
  }, ms);
}

// Spell colors per witch clip — used for the cast-flash on her light pair
const SPELL_COLORS = {
  witchinghour: { r:   0, g: 200, b:  40 },  // green
  catcrow:      { r: 255, g: 120, b:   0 },  // amber
  spellbound:   { r:  40, g: 120, b: 255 },  // blue
  seance:       { r: 160, g:   0, b: 220 },  // purple
};

// Spell-cast flash on the witch's light pair: erupt white, flicker to spell color,
// hold as her glow, then restore to previous look after the clip window.
function castSpellLights(clip) {
  const ids = getSlotIds('witch');
  if (!ids.length) return;
  const spell = SPELL_COLORS[clip] || SPELL_COLORS.witchinghour;
  const prev = goveeDevices
    .filter(d => ids.includes(d.id))
    .map(d => ({ id: d.id, color: { ...d.color }, brightness: d.brightness }));

  goveeSetColor(255, 255, 255, ids).catch(() => {});
  goveeSetBrightness(100, ids).catch(() => {});
  setTimeout(() => { goveeSetColor(spell.r, spell.g, spell.b, ids).catch(() => {}); }, 350);
  setTimeout(() => { goveeSetColor(255, 255, 255, ids).catch(() => {}); }, 700);
  setTimeout(() => {
    goveeSetColor(spell.r, spell.g, spell.b, ids).catch(() => {});
    goveeSetBrightness(85, ids).catch(() => {});
  }, 1000);

  // Restore previous look when her 30s window ends
  setTimeout(async () => {
    for (const snap of prev) {
      const dev = goveeDevices.find(d => d.id === snap.id);
      if (!dev) continue;
      await goveeSend(dev.ip, { cmd: 'colorwc', data: { color: snap.color, colorTemInKelvin: 0 } }).catch(() => {});
      await goveeSend(dev.ip, { cmd: 'brightness', data: { value: snap.brightness } }).catch(() => {});
      dev.color = snap.color;
      dev.brightness = snap.brightness;
    }
    broadcastGovee();
  }, 30000);
}

async function fireWitch(clip) {
  broadcastLog(`Witch: ${clip}`, 'WITCH');
  playWitchClip(clip);
  castSpellLights(clip);
  try {
    const currentZ3 = state.volumes.z3;
    const currentZ1 = state.volumes.z1;
    const boost  = clampVol('z3', currentZ3 + 8);
    // Duck skeleton zone 8 steps while witch is active — skeletons are ~22 ft away and bleed into her mic
    const ducked = clampVol('z1', Math.max(0, currentZ1 - 8));
    await sendISCP(`${ZONE_CMD.z3}${volToHex(boost)}`);
    if (ducked !== currentZ1) {
      await sendISCP(`${ZONE_CMD.z1}${volToHex(ducked)}`);
      state.volumes.z1 = ducked;
      broadcastLog('Witch active — skeleton zone ducked -8', 'AUDIO');
      broadcastState();
    }
    setTimeout(async () => {
      try {
        await sendISCP(`${ZONE_CMD.z3}${volToHex(currentZ3)}`);
        if (ducked !== currentZ1) {
          await sendISCP(`${ZONE_CMD.z1}${volToHex(currentZ1)}`);
          state.volumes.z1 = currentZ1;
          broadcastLog('Witch done — skeleton zone restored', 'AUDIO');
          broadcastState();
        }
      } catch (_) {}
    }, 30000);
  } catch (e) {
    broadcastLog(`Witch error: ${e.message}`, 'SYSTEM');
  }
}

// ─── Character trigger ────────────────────────────────────────────────────────
const CHAR_CONFIG = {
  grimreaper: {
    label: 'Grim Reaper',
    z2Boost: 12, fogDur: 7000, light: 'coldblue', bri: 85,
    flashColor: { r:255, g:255, b:255 }, holdColor: 'coldblue',
  },
  headlesshorseman: {
    label: 'Headless Horseman',
    z2Boost: 10, fogDur: 3000, light: 'bloodred', bri: 100,
    flashColor: { r:255, g:255, b:255 }, holdColor: 'bloodred',
  },
  pumpkinking: {
    label: 'Pumpkin King',
    z2Boost: 14, fogDur: 12000, light: 'witchgreen', bri: 90,
    flashColor: { r:255, g:130, b:0 }, holdColor: 'witchgreen',
  },
};

// ─── VLC Playback ─────────────────────────────────────────────────────────────
const VLC_PATH    = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
const MEDIA_DIR   = 'C:\\Users\\tdell\\OneDrive\\Desktop\\LEGENDS ATMOS';
const STORM_DIR   = 'C:\\Users\\tdell\\OneDrive\\Desktop\\storm';
const AMBIENT_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\graveyard ambient';
const SKELETON_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\SKELETON';
const WITCH_DIR   = 'C:\\Users\\tdell\\OneDrive\\Desktop\\WITCH';

// Drop these audio files in the SKELETON folder — edit the filenames here if yours differ
const SKELETON_FILES = { left: 'skeleton-left.mp3', right: 'skeleton-right.mp3' };

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
let vlcProcess      = null;
let skeletonProcess = null;
let witchProcess    = null;
let ambientProcess  = null;
let ambientActive   = false;
let fxProcess       = null;
let graveyardCycle  = { active: false, index: 0, timer: null };

function playStormClip(overhead) {
  const file = overhead
    ? OVERHEAD_FILE
    : STORM_FILES[Math.floor(Math.random() * STORM_FILES.length)];
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

const AMBIENT_FILE = 'graveyardam.mp3';

let ambientShouldRun = false;
function startAmbient() {
  if (ambientProcess) return;
  ambientShouldRun = true;
  broadcastLog('Graveyard ambient loop started', 'AUDIO');
  ambientProcess = spawn(VLC_PATH, [
    path.join(AMBIENT_DIR, AMBIENT_FILE),
    '--intf', 'dummy', '--loop', '--no-video',
  ], { stdio: 'ignore' });
  ambientActive = true;
  ambientProcess.on('exit', (code) => {
    ambientProcess = null;
    ambientActive = false;
    broadcastState();
    if (ambientShouldRun && code !== 0 && code !== null) {
      broadcastLog('Ambient VLC crashed — restarting in 3s', 'AUDIO');
      setTimeout(() => { if (ambientShouldRun) startAmbient(); }, 3000);
    }
  });
  ambientProcess.on('error', (e) => {
    broadcastLog(`Ambient VLC error: ${e.message}`, 'SYSTEM');
  });
}

function stopAmbient() {
  ambientShouldRun = false;
  if (ambientProcess) {
    try {
      // Windows-safe kill: taskkill terminates VLC and any child processes
      spawn('taskkill', ['/pid', ambientProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
    } catch (_) {}
    ambientProcess = null;
    broadcastLog('Graveyard ambient loop stopped', 'AUDIO');
  }
  ambientActive = false;
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

  // Flash the skeleton Govee slot white, then restore
  const ids = getSlotIds('skeleton');
  if (ids.length) {
    const prev = goveeDevices
      .filter(d => ids.includes(d.id))
      .map(d => ({ id: d.id, color: { ...d.color }, brightness: d.brightness }));
    goveeSetColor(255, 255, 255, ids).catch(() => {});
    goveeSetBrightness(100, ids).catch(() => {});
    setTimeout(async () => {
      for (const snap of prev) {
        const dev = goveeDevices.find(d => d.id === snap.id);
        if (!dev) continue;
        await goveeSend(dev.ip, { cmd: 'colorwc', data: { color: snap.color, colorTemInKelvin: 0 } }).catch(() => {});
        await goveeSend(dev.ip, { cmd: 'brightness', data: { value: snap.brightness } }).catch(() => {});
        dev.color = snap.color;
        dev.brightness = snap.brightness;
      }
      broadcastGovee();
    }, 800);
  }
  return true;
}

function playClip(character, title) {
  const clips = CLIP_MAP[character];
  if (!clips) return;
  const clipTitle = title || Object.keys(clips)[Math.floor(Math.random() * Object.keys(clips).length)];
  const filename  = clips[clipTitle];
  if (!filename) return;
  if (vlcProcess) { try { vlcProcess.kill(); } catch (_) {} vlcProcess = null; }
  broadcastLog(`Playing: ${clipTitle}`, 'VIDEO');
  vlcProcess = spawn(VLC_PATH, [
    path.join(MEDIA_DIR, filename),
    '--play-and-exit', '--fullscreen', '--no-video-title-show', '--qt-start-minimized',
  ], { detached: true, stdio: 'ignore' });
  vlcProcess.unref();
  vlcProcess.on('exit', () => { vlcProcess = null; });
}

function stopVLC() {
  if (vlcProcess) {
    try { vlcProcess.kill(); } catch (_) {}
    vlcProcess = null;
    broadcastLog('VLC stopped', 'VIDEO');
  }
}

// ─── Clip maps ────────────────────────────────────────────────────────────────
const CLIP_MAP = {
  grimreaper: {
    'Fear the Reaper':     'Grim Reaper_Fear the Reaper_Holl_H.mp4',
    'Out of Time':         'Grim Reaper_Out of Time_Holl_H.mp4',
    'The Ferryman':        'Grim Reaper_The Ferryman_Holl_H.mp4',
    'Deep Sleeper':        'Grim Reaper_Deep Sleeper_Holl_H.mp4',
    'Dreadful Apparition': 'Grim Reaper_Dreadful Apparition_Holl_H.mp4',
    'Grave Warning':       'Grim Reaper_Grave Warning_Holl_H.mp4',
    'Startle Scare 1':     'Grim Reaper_Startle Scare1_Holl_H.mp4',
    'Startle Scare 2':     'Grim Reaper_Startle Scare2_Holl_H.mp4',
    'Startle Scare 3':     'Grim Reaper_Startle Scare3_Holl_H.mp4',
  },
  headlesshorseman: {
    'Headless Hessian':     'Horseman_Headless Hessian_Holl_H.mp4',
    'Ride of the Horseman': 'Horseman_Ride of the Horseman_Holl_H.mp4',
    'Sleepy Hollow Steed':  'Horseman_Sleepy Hollow Steed_Holl_H.mp4',
    'Stormy Hollow':        'Horseman_Stormy Hollow_Holl_H.mp4',
    'Startle Scare 1':      'Horseman_Startle Scare 1_Holl_H.mp4',
    'Startle Scare 2':      'Horseman_Startle Scare 2_Holl_H.mp4',
    'Startle Scare 3':      'Horseman_Startle Scare 3_Holl_H.mp4',
  },
  pumpkinking: {
    'Hail to the King':  'Pumpkin King_Hail to the King_Holl_H.mp4',
    'Hungry Goblin':     'Pumpkin King_Hungry Goblin_Holl_H.mp4',
    'Lord of the Patch': 'Pumpkin King_Lord of the Patch_Holl_H.mp4',
    'The Scarecrow':     'Pumpkin King_The Scarecrow_Holl_H.mp4',
    'Startle Scare 1':   'Pumpkin King_Startle Scare1_Holl_H.mp4',
    'Startle Scare 2':   'Pumpkin King_Startle Scare2_Holl_H.mp4',
    'Startle Scare 3':   'Pumpkin King_Startle Scare3_Holl_H.mp4',
  },
};

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

// ─── Character fire ───────────────────────────────────────────────────────────
async function fireCharacter(character, clip) {
  const c = CHAR_CONFIG[character];
  if (!c) return;
  broadcastLog(`Character: ${c.label}`, 'VIDEO');
  playClip(character, clip);

  const ambientZ2 = state.volumes.z2;
  const boostedZ2 = clampVol('z2', ambientZ2 + c.z2Boost);
  const origZ1    = state.volumes.z1;
  const duckedZ1  = settings.autoDuckSkeleton ? clampVol('z1', Math.max(0, origZ1 - 8)) : origZ1;

  try {
    const fc = c.flashColor;
    await goveeSetColor(fc.r, fc.g, fc.b);
    await goveeSetBrightness(100);
    setTimeout(() => {
      const hc = GOVEE_COLORS[c.holdColor] || GOVEE_COLORS.orange;
      goveeSetColor(hc.r, hc.g, hc.b);
      goveeSetBrightness(c.bri);
    }, 300);

    await sendISCP(`${ZONE_CMD.z2}${volToHex(boostedZ2)}`);
    state.volumes.z2 = boostedZ2;

    if (settings.autoDuckSkeleton && duckedZ1 !== origZ1) {
      await sendISCP(`${ZONE_CMD.z1}${volToHex(duckedZ1)}`);
      state.volumes.z1 = duckedZ1;
    }

    if (settings.fogWithCharacters && c.fogDur > 0) fogBurst(c.fogDur);
    broadcastState();

    setTimeout(async () => {
      try {
        await sendISCP(`${ZONE_CMD.z2}${volToHex(ambientZ2)}`);
        state.volumes.z2 = ambientZ2;
        if (settings.autoDuckSkeleton && duckedZ1 !== origZ1) {
          await sendISCP(`${ZONE_CMD.z1}${volToHex(origZ1)}`);
          state.volumes.z1 = origZ1;
        }
        broadcastLog(`Character: ${c.label} ended, levels restored`, 'AUDIO');
        broadcastState();
      } catch (_) {}
    }, 20000);
  } catch (e) {
    broadcastLog(`Character error: ${e.message}`, 'SYSTEM');
  }
}

// ─── Scene presets ────────────────────────────────────────────────────────────
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
  state.paused = false;
  state.stormActive = false;
  strikeIndex = 0;
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  state.autoScare.active = false;
  if (state.autoScare.timer) { clearTimeout(state.autoScare.timer); state.autoScare.timer = null; }
  state.witchTimer.active = false;
  if (state.witchTimer.timer) { clearTimeout(state.witchTimer.timer); state.witchTimer.timer = null; }
  stopFogAuto();
  stopVLC();
  stopWitch();
  stopAmbient();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
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
  stopFogAuto();
  stopVLC();
  stopWitch();
  stopAmbient();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
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
    state.autoScare.active = false;
    state.witchTimer.active = false;
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

app.post('/api/character', async (req, res) => {
  const { character, clip } = req.body;
  const key = character?.toLowerCase().replace(/\s/g, '');
  if (!CHAR_CONFIG[key]) return res.status(400).json({ error: 'unknown character' });
  if (!debounceRoute(`char-${key}`, 3000, () => {})) {
    return res.json({ ok: false, debounced: true });
  }
  await fireCharacter(key, clip);
  res.json({ ok: true, character: key });
});

app.post('/api/vlc/stop', (req, res) => {
  stopVLC();
  res.json({ ok: true });
});

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

app.post('/api/ambient/toggle', (req, res) => {
  if (ambientActive) stopAmbient();
  else startAmbient();
  res.json({ ok: true, active: ambientActive });
});

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

app.post('/api/autoscare/toggle', (req, res) => {
  const { intervalMin, chars } = req.body;
  if (intervalMin) state.autoScare.intervalMin = intervalMin;
  if (chars) state.autoScare.chars = { ...state.autoScare.chars, ...chars };
  state.autoScare.active = !state.autoScare.active;
  broadcastLog(`Auto Scare ${state.autoScare.active ? 'ON' : 'OFF'}`, 'SCARE');
  if (state.autoScare.active) {
    scheduleNextScare();
  } else {
    if (state.autoScare.timer) { clearTimeout(state.autoScare.timer); state.autoScare.timer = null; }
    state.autoScare.nextAt = null;
  }
  broadcastState();
  res.json({ ok: true, active: state.autoScare.active });
});

app.post('/api/autoscare/config', (req, res) => {
  const { intervalMin, chars } = req.body;
  if (intervalMin) state.autoScare.intervalMin = intervalMin;
  if (chars) state.autoScare.chars = { ...state.autoScare.chars, ...chars };
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/witch/toggle', (req, res) => {
  state.witchTimer.active = !state.witchTimer.active;
  broadcastLog(`Witch Timer ${state.witchTimer.active ? 'ON' : 'OFF'}`, 'WITCH');
  if (state.witchTimer.active) {
    scheduleNextWitch();
  } else {
    if (state.witchTimer.timer) { clearTimeout(state.witchTimer.timer); state.witchTimer.timer = null; }
    state.witchTimer.nextAt = null;
  }
  broadcastState();
  res.json({ ok: true, active: state.witchTimer.active });
});

app.post('/api/witch/fire', async (req, res) => {
  const { clip = 'manual' } = req.body;
  await fireWitch(clip);
  res.json({ ok: true });
});

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
    // BUG FIX: kill previous FX before spawning new one
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
  const { autoDuckSkeleton, fogWithCharacters, hapticFeedback } = req.body;
  if (autoDuckSkeleton !== undefined) settings.autoDuckSkeleton = !!autoDuckSkeleton;
  if (fogWithCharacters !== undefined) settings.fogWithCharacters = !!fogWithCharacters;
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

app.post('/api/govee/add', (req, res) => {
  const { ip, name, slot } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  if (goveeDevices.length >= 8) return res.status(400).json({ error: 'max 8 devices' });
  const existing = goveeDevices.find(d => d.ip === ip);
  if (existing) {
    // Update slot mapping for existing device
    if (slot && GOVEE_IPS.hasOwnProperty(slot)) {
      GOVEE_IPS[slot] = ip;
      GOVEE_SLOT_IDS[slot] = existing.id;
    }
    return res.json({ ok: true, device: existing });
  }
  if (slot && GOVEE_IPS.hasOwnProperty(slot)) {
    GOVEE_IPS[slot] = ip;
  }
  const dev = {
    id: `govee-${Date.now()}`, name: name || `Light ${goveeDevices.length + 1}`,
    ip, model: 'Manual', on: true, color: { r:255, g:98, b:0 }, brightness: 100,
  };
  if (slot) GOVEE_SLOT_IDS[slot] = dev.id;
  goveeDevices.push(dev);
  broadcastLog(`Govee: added ${dev.name} @ ${ip}`, 'LIGHT');
  broadcastGovee();
  res.json({ ok: true, device: dev });
});

app.post('/api/govee/remove', (req, res) => {
  const { id } = req.body;
  goveeDevices = goveeDevices.filter(d => d.id !== id);
  for (const slot of Object.keys(GOVEE_SLOT_IDS)) {
    if (GOVEE_SLOT_IDS[slot] === id) delete GOVEE_SLOT_IDS[slot];
  }
  broadcastGovee();
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

// ─── Graveyard Auto Cycle ─────────────────────────────────────────────────────
const GRAVEYARD_FILES = Array.from({length:23}, (_,i) => `clip${String(i+1).padStart(2,'0')}.mp3`);

function scheduleGraveyardCycle() {
  if (!graveyardCycle.active) return;
  graveyardCycle.timer = setTimeout(() => {
    if (!graveyardCycle.active) return;
    const file = GRAVEYARD_FILES[graveyardCycle.index % GRAVEYARD_FILES.length];
    graveyardCycle.index++;
    broadcastLog(`Graveyard cycle: ${file}`, 'AUDIO');
    if (ambientProcess) { try { ambientProcess.kill(); } catch (_) {} ambientProcess = null; }
    ambientProcess = spawn(VLC_PATH, [
      path.join(AMBIENT_DIR, file), '--intf', 'dummy', '--play-and-exit', '--no-video',
    ], { stdio: 'ignore' });
    ambientProcess.on('exit', () => {
      ambientProcess = null;
      if (graveyardCycle.active) scheduleGraveyardCycle();
    });
  }, 120000); // 2 min gap
}

app.post('/api/graveyard/cycle/toggle', (req, res) => {
  graveyardCycle.active = !graveyardCycle.active;
  broadcastLog(`Graveyard cycle ${graveyardCycle.active ? 'ON' : 'OFF'}`, 'AUDIO');
  if (graveyardCycle.active) {
    graveyardCycle.index = 0;
    scheduleGraveyardCycle();
  } else {
    if (graveyardCycle.timer) { clearTimeout(graveyardCycle.timer); graveyardCycle.timer = null; }
  }
  broadcast({ type: 'state', data: stateSnapshot() });
  res.json({ ok: true, active: graveyardCycle.active });
});

app.post('/api/strikedown', async (req, res) => {
  broadcastLog('STRIKE DOWN — lights to white, all else stopping', 'SYSTEM');
  // Stop all timers
  state.stormActive = false;
  strikeIndex = 0;
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  state.stormNextAt = null;
  state.autoScare.active = false;
  if (state.autoScare.timer) { clearTimeout(state.autoScare.timer); state.autoScare.timer = null; }
  state.autoScare.nextAt = null;
  state.witchTimer.active = false;
  if (state.witchTimer.timer) { clearTimeout(state.witchTimer.timer); state.witchTimer.timer = null; }
  state.witchTimer.nextAt = null;
  graveyardCycle.active = false;
  if (graveyardCycle.timer) { clearTimeout(graveyardCycle.timer); graveyardCycle.timer = null; }
  stopFogAuto();
  stopVLC();
  stopWitch();
  stopAmbient();
  if (fxProcess) { try { fxProcess.kill(); } catch (_) {} fxProcess = null; }
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
  if (step.character) fireCharacter(step.character).catch(() => {});
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
