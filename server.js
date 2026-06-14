const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config ───────────────────────────────────────────────────────────────────
let config = {
  receiverIp:   '192.168.1.190',
  receiverPort: 60128,
  // Onkyo 0-80 scale hard caps
  maxVol: { z1: 60, z2: 48, z3: 44, sub: 52 },
};

// ─── Settings ─────────────────────────────────────────────────────────────────
let settings = {
  autoDuckJamboree: true,
  fogWithCharacters: true,
  hapticFeedback: true,
};

// ─── Govee Devices ────────────────────────────────────────────────────────────
let goveeDevices = [];
const GOVEE_IPS = {
  graveyard1: '', graveyard2: '', graveyard3: '', graveyard4: '',
  witch1: '', witch2: '',
};

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

async function goveeAll(cmdObj, ids) {
  const targets = ids ? goveeDevices.filter(d => ids.includes(d.id)) : goveeDevices;
  await Promise.allSettled(targets.map(d => goveeSend(d.ip, cmdObj)));
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
  orange:   { r:255, g: 98, b:  0 },
  green:    { r:  0, g:180, b: 30 },
  purple:   { r:100, g:  0, b:180 },
  blue:     { r:  0, g: 80, b:255 },
  coldblue: { r: 30, g:120, b:255 },
  white:    { r:255, g:255, b:255 },
  red:      { r:204, g:  0, b:  0 },
  deepred:  { r:120, g:  0, b:  0 },
  bloodred: { r:180, g:  0, b:  0 },
  teal:     { r:  0, g:200, b:180 },
  pink:     { r:255, g: 20, b:120 },
  yellow:   { r:255, g:200, b:  0 },
  witchgreen:{ r:  0, g:180, b: 30 },
  off:      { r:  0, g:  0, b:  0 },
};

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  connected:    false,
  fogActive:    false,
  fogTimer:     null,
  stormActive:  false,
  stormTimer:   null,
  stormPreset:  'distant',
  stormNextAt:  null,
  kidMode:      false,
  paused:       false,
  sceneMode:    'normal',
  volumes:      { z1: 30, z2: 25, z3: 20, sub: 30 },
  mute:         { z1: false, z2: false, z3: false },
  autoScare: {
    active:      false,
    intervalMin: 2,
    chars:       { grimreaper: true, headlesshorseman: true, pumpkinking: true },
    lastChar:    null,
    timer:       null,
    nextAt:      null,
  },
  witchTimer: {
    active:  false,
    timer:   null,
    nextAt:  null,
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

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}
function broadcastState() { broadcast({ type: 'state', data: stateSnapshot() }); }
function broadcastLog(msg, category = 'SYSTEM') {
  broadcast({ type: 'log', msg, category });
  console.log(`[${category}] ${msg}`);
}

function stateSnapshot() {
  return {
    connected:   state.connected,
    fogActive:   state.fogActive,
    stormActive: state.stormActive,
    stormPreset: state.stormPreset,
    stormNextAt: state.stormNextAt,
    kidMode:     state.kidMode,
    paused:      state.paused,
    sceneMode:   state.sceneMode,
    volumes:     state.volumes,
    mute:        state.mute,
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
  };
}

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

// ─── Storm engine ─────────────────────────────────────────────────────────────
const STORM_PRESETS = {
  distant:    { minMs: 300000, maxMs: 360000, z1Vol: 28, fog: false, flash: 'single'  },
  approaching:{ minMs: 240000, maxMs: 300000, z1Vol: 42, fog: false, flash: 'double'  },
  overhead:   { minMs: 180000, maxMs: 300000, z1Vol: 60, fog: true,  flash: 'storm'   },
};

async function fireStrikeSequence(preset) {
  const p = STORM_PRESETS[preset] || STORM_PRESETS.distant;
  broadcastLog('Storm: STRIKE!', 'AUDIO');
  playStormClip();
  try {
    // Thunder FIRST
    const v = clampVol('z1', p.z1Vol);
    await sendISCP(`${ZONE_CMD.z1}${volToHex(v)}`);
    state.volumes.z1 = v;
    broadcastState();
    if (p.fog) { fogBurst(5000); }
    // Delay then lightning flash
    const delay = 1200 + Math.random() * 800;
    setTimeout(async () => {
      broadcastLog('Storm: lightning flash', 'LIGHT');
      await goveeSetColor(255, 255, 255);
      await goveeSetBrightness(100);
      const restoreMs = p.flash === 'storm' ? 600 : p.flash === 'double' ? 400 : 250;
      setTimeout(() => {
        goveeSetColor(GOVEE_COLORS.orange.r, GOVEE_COLORS.orange.g, GOVEE_COLORS.orange.b);
      }, restoreMs);
      if (p.flash === 'double') {
        setTimeout(async () => {
          await goveeSetColor(255, 255, 255);
          setTimeout(() => goveeSetColor(GOVEE_COLORS.orange.r, GOVEE_COLORS.orange.g, GOVEE_COLORS.orange.b), 200);
        }, restoreMs + 150);
      }
    }, delay);
  } catch (e) {
    broadcastLog(`Storm error: ${e.message}`, 'SYSTEM');
  }
}

function scheduleNextStrike() {
  if (!state.stormActive) return;
  const p = STORM_PRESETS[state.stormPreset] || STORM_PRESETS.distant;
  const delay = p.minMs + Math.random() * (p.maxMs - p.minMs);
  state.stormNextAt = Date.now() + delay;
  broadcastState();
  broadcastLog(`Storm: next strike in ${Math.round(delay / 1000)}s [${state.stormPreset}]`, 'SYSTEM');
  state.stormTimer = setTimeout(async () => {
    if (!state.stormActive || state.paused) return scheduleNextStrike();
    await fireStrikeSequence(state.stormPreset);
    scheduleNextStrike();
  }, delay);
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

async function fireWitch(clip) {
  broadcastLog(`Witch: ${clip}`, 'WITCH');
  playWitchClip(clip);
  try {
    const currentZ3 = state.volumes.z3;
    const boost = clampVol('z3', currentZ3 + 8);
    await sendISCP(`${ZONE_CMD.z3}${volToHex(boost)}`);
    setTimeout(async () => {
      try { await sendISCP(`${ZONE_CMD.z3}${volToHex(currentZ3)}`); } catch (_) {}
    }, 30000);
  } catch (e) {
    broadcastLog(`Witch error: ${e.message}`, 'SYSTEM');
  }
}

// ─── Character trigger ────────────────────────────────────────────────────────
const CHAR_CONFIG = {
  grimreaper: {
    label: 'Grim Reaper',
    // Boost z2 (graveyard ambient zone) above ambient for character audio
    z2Boost: 12,
    fogDur: 7000,
    light: 'coldblue',
    bri: 85,
    flashColor: { r:255, g:255, b:255 },
    holdColor: 'coldblue',
  },
  headlesshorseman: {
    label: 'Headless Horseman',
    z2Boost: 10,
    fogDur: 3000,
    light: 'bloodred',
    bri: 100,
    flashColor: { r:255, g:255, b:255 },
    holdColor: 'bloodred',
  },
  pumpkinking: {
    label: 'Pumpkin King',
    z2Boost: 14,
    fogDur: 12000,
    light: 'witchgreen',
    bri: 90,
    flashColor: { r:255, g:130, b:0 },
    holdColor: 'witchgreen',
  },
};

// ─── VLC Playback ─────────────────────────────────────────────────────────────
const VLC_PATH   = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
const MEDIA_DIR  = 'C:\\Users\\tdell\\OneDrive\\Desktop\\LEGENDS ATMOS';
const STORM_DIR  = 'C:\\Users\\tdell\\OneDrive\\Desktop\\storm';

const STORM_FILES = [
  'bijan6207-thunderstorm-409071.mp3',
  'freesound_community-lightning-storm-6077.mp3',
  'freesound_community-lightning-strike-29683.mp3',
  'soundsforyou-natural-thunder-113219.mp3',
  'u_39xav15uou-lightning-237994.mp3',
];

let stormProcess = null;

function playStormClip() {
  const file = STORM_FILES[Math.floor(Math.random() * STORM_FILES.length)];
  const filepath = path.join(STORM_DIR, file);
  if (stormProcess) { try { stormProcess.kill(); } catch (_) {} stormProcess = null; }
  broadcastLog(`Storm clip: ${file}`, 'AUDIO');
  stormProcess = spawn(VLC_PATH, [
    filepath, '--play-and-exit', '--no-video', '--qt-start-minimized',
  ], { detached: true, stdio: 'ignore' });
  stormProcess.unref();
  stormProcess.on('exit', () => { stormProcess = null; });
}

const CLIP_MAP = {
  grimreaper: {
    'Fear the Reaper':       'Grim Reaper_Fear the Reaper_Holl_H.mp4',
    'Out of Time':           'Grim Reaper_Out of Time_Holl_H.mp4',
    'The Ferryman':          'Grim Reaper_The Ferryman_Holl_H.mp4',
    'Deep Sleeper':          'Grim Reaper_Deep Sleeper_Holl_H.mp4',
    'Dreadful Apparition':   'Grim Reaper_Dreadful Apparition_Holl_H.mp4',
    'Grave Warning':         'Grim Reaper_Grave Warning_Holl_H.mp4',
    'Startle Scare 1':       'Grim Reaper_Startle Scare1_Holl_H.mp4',
    'Startle Scare 2':       'Grim Reaper_Startle Scare2_Holl_H.mp4',
    'Startle Scare 3':       'Grim Reaper_Startle Scare3_Holl_H.mp4',
  },
  headlesshorseman: {
    'Headless Hessian':      'Horseman_Headless Hessian_Holl_H.mp4',
    'Ride of the Horseman':  'Horseman_Ride of the Horseman_Holl_H.mp4',
    'Sleepy Hollow Steed':   'Horseman_Sleepy Hollow Steed_Holl_H.mp4',
    'Stormy Hollow':         'Horseman_Stormy Hollow_Holl_H.mp4',
    'Startle Scare 1':       'Horseman_Startle Scare 1_Holl_H.mp4',
    'Startle Scare 2':       'Horseman_Startle Scare 2_Holl_H.mp4',
    'Startle Scare 3':       'Horseman_Startle Scare 3_Holl_H.mp4',
  },
  pumpkinking: {
    'Hail to the King':      'Pumpkin King_Hail to the King_Holl_H.mp4',
    'Hungry Goblin':         'Pumpkin King_Hungry Goblin_Holl_H.mp4',
    'Lord of the Patch':     'Pumpkin King_Lord of the Patch_Holl_H.mp4',
    'The Scarecrow':         'Pumpkin King_The Scarecrow_Holl_H.mp4',
    'Startle Scare 1':       'Pumpkin King_Startle Scare1_Holl_H.mp4',
    'Startle Scare 2':       'Pumpkin King_Startle Scare2_Holl_H.mp4',
    'Startle Scare 3':       'Pumpkin King_Startle Scare3_Holl_H.mp4',
  },
};

let vlcProcess = null;

// ─── Jamboree Playback (separate VLC instance) ────────────────────────────────
const JAMBOREE_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\JACKOLANTERN';

const JAMBOREE_MAP = {
  'Addams Family':        'JOLJ3_Addams Family_Trio_Pumpkin.mp4',
  'Ghostbusters':         'JOLJ3_Ghostbusters_Trio_Pumpkin.mp4',
  'Monster Mash':         'JOLJ3_Monster Mash_Trio_Pumpkin.mp4',
  'The Pumpkin Song':     'JOLJ_The Pumpkin Song_Trio_Pumpkin.mp4',
  'Three Children Bold':  'JOLJ_Three Children Bold_Trio_Pumpkin.mp4',
  'Twas The Night':       'JOLJ_Twas The Night_Trio_Pumpkin.mp4',
  'Hall of Pumpkin King': 'JOLJ_Hall of Pumpkin King_Trio_Pumpkin.mp4',
  'Jokes 1':              'JOLJ_Jokes 1_Trio_Pumpkin.mp4',
  'Jokes 2':              'JOLJ_Jokes 2_Trio_Pumpkin.mp4',
  'Jokes 3':              'JOLJ_Jokes 3_Trio_Pumpkin.mp4',
  'Funny Faces':          'JOLJ_Funny Faces_Trio_Pumpkin.mp4',
  'Heckling Hijinks':     'JOL2_Heckling Hijinks_Trio_Pumpkin_H.mp4',
  'Lord of the Gourds':   'JOL2_Lord of the Gourds_Trio_Pumpkin_H.mp4',
  'The Raven':            'JOL2_The Raven_Trio_Pumpkin_H.mp4',
  'Treater Greeters':     'JOL2_Treater Greeters_Trio_Pumpkin_H.mp4',
};

let jamboreeProcess = null;

// ─── Witch Playback (separate VLC instance) ───────────────────────────────────
const WITCH_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\WITCH';

const WITCH_MAP = {
  witchinghour: 'WH_Song 1_WitchingHour_3DFX_H.mp4',
  catcrow:      'WH_Song 2_CatCrow_3DFX_H.mp4',
  spellbound:   'WH_Spell 1_WH_Spellbound_3DFX_H.mp4',
  seance:       'WH_Spell 3_Seance_3DFX_H.mp4',
};

let witchProcess = null;

// ─── Graveyard Ambient Loop (separate VLC instance, audio only) ───────────────
const AMBIENT_DIR = 'C:\\Users\\tdell\\OneDrive\\Desktop\\graveyard ambient';

const AMBIENT_FILES = [
  'SS_Corpse Crowd_Wall_Spotlight_H.mp4',
  'SS_Grave Digger_Wall_Candle_H.mp4',
  'SS_Grave Risers_Wall_Spotlight_H.mp4',
  'SS_Grave Riser_Wall_Spotlight_H.mp4',
  'SS_Wicked Watchers_Wall_Flashlight_H.mp4',
  'SS_Zombie Hands_Wall_Spotlight_H.mp4',
  'SS_Zombie Hand_Wall_Spotlight_H.mp4',
];

let ambientProcess = null;
let ambientActive  = false;

function startAmbient() {
  if (ambientProcess) return;
  broadcastLog('Graveyard ambient loop started', 'AUDIO');
  const files = AMBIENT_FILES.map(f => path.join(AMBIENT_DIR, f));
  ambientProcess = spawn(VLC_PATH, [
    ...files,
    '--loop',
    '--random',
    '--no-video',
    '--gain', '0.6',
    '--qt-start-minimized',
  ], { detached: true, stdio: 'ignore' });
  ambientProcess.unref();
  ambientActive = true;
  ambientProcess.on('exit', () => { ambientProcess = null; ambientActive = false; });
}

function stopAmbient() {
  if (ambientProcess) {
    try { ambientProcess.kill(); } catch (_) {}
    ambientProcess = null;
    broadcastLog('Graveyard ambient loop stopped', 'AUDIO');
  }
  ambientActive = false;
}

function playWitchClip(clip) {
  // Random pick for timer auto-fires or unknown clip names
  const keys = Object.keys(WITCH_MAP);
  const key  = WITCH_MAP[clip] ? clip : keys[Math.floor(Math.random() * keys.length)];
  const filepath = path.join(WITCH_DIR, WITCH_MAP[key]);

  if (witchProcess) {
    try { witchProcess.kill(); } catch (_) {}
    witchProcess = null;
  }

  broadcastLog(`Witch clip: ${key}`, 'WITCH');
  witchProcess = spawn(VLC_PATH, [
    filepath,
    '--play-and-exit',
    '--no-video-title-show',
    '--qt-start-minimized',
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

function playJamboree(title) {
  const filename = JAMBOREE_MAP[title];
  if (!filename) return false;
  const filepath = path.join(JAMBOREE_DIR, filename);

  if (jamboreeProcess) {
    try { jamboreeProcess.kill(); } catch (_) {}
    jamboreeProcess = null;
  }

  broadcastLog(`Jamboree: ${title}`, 'VIDEO');
  jamboreeProcess = spawn(VLC_PATH, [
    filepath,
    '--play-and-exit',
    '--fullscreen',
    '--no-video-title-show',
    '--qt-start-minimized',
  ], { detached: true, stdio: 'ignore' });
  jamboreeProcess.unref();
  jamboreeProcess.on('exit', () => { jamboreeProcess = null; });
  return true;
}

function stopJamboree() {
  if (jamboreeProcess) {
    try { jamboreeProcess.kill(); } catch (_) {}
    jamboreeProcess = null;
    broadcastLog('Jamboree stopped', 'VIDEO');
  }
}

function playClip(character, title) {
  const clips = CLIP_MAP[character];
  if (!clips) return;
  // If no title given, pick a random clip for this character
  const clipTitle = title || Object.keys(clips)[Math.floor(Math.random() * Object.keys(clips).length)];
  const filename  = clips[clipTitle];
  if (!filename) return;
  const filepath = path.join(MEDIA_DIR, filename);

  // Kill any running VLC instance first
  if (vlcProcess) {
    try { vlcProcess.kill(); } catch (_) {}
    vlcProcess = null;
  }

  broadcastLog(`Playing: ${clipTitle}`, 'VIDEO');
  vlcProcess = spawn(VLC_PATH, [
    filepath,
    '--play-and-exit',
    '--fullscreen',
    '--no-video-title-show',
    '--qt-start-minimized',
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

async function fireCharacter(character, clip) {
  const c = CHAR_CONFIG[character];
  if (!c) return;
  broadcastLog(`Character: ${c.label}`, 'VIDEO');
  playClip(character, clip);

  const ambientZ2 = state.volumes.z2;
  const boostedZ2 = clampVol('z2', ambientZ2 + c.z2Boost);

  // If auto-duck Jamboree is on, lower z1 during character clip
  const origZ1 = state.volumes.z1;
  const duckedZ1 = settings.autoDuckJamboree ? clampVol('z1', Math.max(0, origZ1 - 8)) : origZ1;

  try {
    // Flash then hold color
    const fc = c.flashColor;
    await goveeSetColor(fc.r, fc.g, fc.b);
    await goveeSetBrightness(100);
    setTimeout(() => {
      const hc = GOVEE_COLORS[c.holdColor] || GOVEE_COLORS.orange;
      goveeSetColor(hc.r, hc.g, hc.b);
      goveeSetBrightness(c.bri);
    }, 300);

    // Boost graveyard zone above ambient
    await sendISCP(`${ZONE_CMD.z2}${volToHex(boostedZ2)}`);
    state.volumes.z2 = boostedZ2;

    // Duck Jamboree if enabled
    if (settings.autoDuckJamboree && duckedZ1 !== origZ1) {
      await sendISCP(`${ZONE_CMD.z1}${volToHex(duckedZ1)}`);
      state.volumes.z1 = duckedZ1;
    }

    // Fog
    if (settings.fogWithCharacters && c.fogDur > 0) {
      fogBurst(c.fogDur);
    }

    broadcastState();

    // Restore after clip (~20 seconds)
    setTimeout(async () => {
      try {
        await sendISCP(`${ZONE_CMD.z2}${volToHex(ambientZ2)}`);
        state.volumes.z2 = ambientZ2;
        if (settings.autoDuckJamboree && duckedZ1 !== origZ1) {
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
// Volumes are Onkyo 0-80 scale values
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
  try {
    fogBurst(duration);
    res.json({ ok: true, duration });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/fog/stop', async (req, res) => {
  try { await fogOff(); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/allstop', async (req, res) => {
  broadcastLog('ALL STOP', 'SYSTEM');
  // Stop timers
  state.paused = false;
  state.stormActive = false;
  if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  state.autoScare.active = false;
  if (state.autoScare.timer) { clearTimeout(state.autoScare.timer); state.autoScare.timer = null; }
  state.witchTimer.active = false;
  if (state.witchTimer.timer) { clearTimeout(state.witchTimer.timer); state.witchTimer.timer = null; }
  stopVLC();
  stopJamboree();
  stopWitch();
  stopAmbient();

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
  stopVLC();
  stopJamboree();
  stopWitch();
  stopAmbient();
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
  await fireCharacter(key, clip);
  res.json({ ok: true, character: key });
});

app.post('/api/vlc/stop', (req, res) => {
  stopVLC();
  res.json({ ok: true });
});

app.post('/api/jamboree/play', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const ok = playJamboree(title);
  if (!ok) return res.status(404).json({ error: 'unknown title' });
  res.json({ ok: true, title });
});

app.post('/api/jamboree/stop', (req, res) => {
  stopJamboree();
  res.json({ ok: true });
});

app.post('/api/ambient/toggle', (req, res) => {
  if (ambientActive) stopAmbient();
  else startAmbient();
  res.json({ ok: true, active: ambientActive });
});

app.post('/api/storm/toggle', (req, res) => {
  const { preset } = req.body;
  state.stormActive = !state.stormActive;
  if (preset) state.stormPreset = preset;
  broadcastLog(`Storm ${state.stormActive ? 'ON' : 'OFF'} [${state.stormPreset}]`, 'SYSTEM');
  if (state.stormActive) {
    scheduleNextStrike();
  } else {
    if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
    state.stormNextAt = null;
  }
  broadcastState();
  res.json({ ok: true, stormActive: state.stormActive, preset: state.stormPreset });
});

app.post('/api/storm/strike', async (req, res) => {
  broadcastLog('Manual storm strike', 'SYSTEM');
  await fireStrikeSequence(state.stormPreset);
  broadcastState();
  res.json({ ok: true });
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
  res.json({ ok: true, fx });
});

app.post('/api/lightning', async (req, res) => {
  broadcastLog('Lightning flash', 'LIGHT');
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
        dev.color = snap.color; dev.brightness = snap.brightness;
      }
      broadcastGovee();
    }, 400);
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
  const { autoDuckJamboree, fogWithCharacters, hapticFeedback } = req.body;
  if (autoDuckJamboree !== undefined) settings.autoDuckJamboree = !!autoDuckJamboree;
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
  if (goveeDevices.find(d => d.ip === ip)) return res.status(400).json({ error: 'already exists' });
  if (slot && GOVEE_IPS.hasOwnProperty(slot)) GOVEE_IPS[slot] = ip;
  const dev = {
    id: `govee-${Date.now()}`, name: name || `Light ${goveeDevices.length + 1}`,
    ip, model: 'Manual', on: true, color: { r:255, g:98, b:0 }, brightness: 100,
  };
  goveeDevices.push(dev);
  broadcastLog(`Govee: added ${dev.name} @ ${ip}`, 'LIGHT');
  broadcastGovee();
  res.json({ ok: true, device: dev });
});

app.post('/api/govee/remove', (req, res) => {
  const { id } = req.body;
  goveeDevices = goveeDevices.filter(d => d.id !== id);
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

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 8080;
server.listen(PORT, () => {
  console.log(`[HAUNT] HAUNT CTRL v3 on http://localhost:${PORT}`);
  testConnection();
});
