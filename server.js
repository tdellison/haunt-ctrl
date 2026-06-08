'use strict';

const express = require('express');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config (mutable at runtime via /api/config) ─────────────────────────────
let config = {
  receiverIp: '192.168.1.190',
  receiverPort: 60128,
  maxCaps: { z1: 65, z2: 60, z3: 55 },
};

// ── Zone volume state ────────────────────────────────────────────────────────
const zoneVolume = { z1: 30, z2: 25, z3: 20 };
const zoneMute   = { z1: false, z2: false, z3: false };

// ── Storm state ──────────────────────────────────────────────────────────────
let stormActive   = false;
let stormPreset   = 'distant';
let stormTimer    = null;
let fogTimer      = null;
let fogActive     = false;
let receiverOnline = false;

// ── ISCP helpers ─────────────────────────────────────────────────────────────
function buildISCPPacket(command) {
  // command e.g. "MVL32"
  const msg     = `!1${command}\r\n`;
  const msgBuf  = Buffer.from(msg, 'ascii');
  const header  = Buffer.alloc(16);
  header.write('ISCP', 0, 'ascii');           // magic
  header.writeUInt32BE(16, 4);               // header size
  header.writeUInt32BE(msgBuf.length, 8);    // data size
  header.writeUInt8(1, 12);                  // version
  // bytes 13-15 = 0x00
  return Buffer.concat([header, msgBuf]);
}

function sendISCP(command) {
  return new Promise((resolve, reject) => {
    console.log(`[ISCP] → ${command}`);
    const socket = new net.Socket();
    const timeout = 3000;
    socket.setTimeout(timeout);

    socket.connect(config.receiverPort, config.receiverIp, () => {
      socket.write(buildISCPPacket(command));
    });

    socket.on('data', (data) => {
      socket.destroy();
      const resp = data.slice(16).toString('ascii').trim();
      console.log(`[ISCP] ← ${resp}`);
      resolve(resp);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('ISCP timeout'));
    });

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

// ── Volume helpers ────────────────────────────────────────────────────────────
// Zone command prefixes
const ZONE_CMD = { z1: 'MVL', z2: 'ZVL', z3: 'VL3' };

function clampVolume(zone, vol) {
  const raw = Math.round(Number(vol));
  const max = config.maxCaps[zone] || 50;
  return Math.max(0, Math.min(max, raw));
}

async function setZoneVolume(zone, vol) {
  const clamped = clampVolume(zone, vol);
  const cmd     = ZONE_CMD[zone];
  if (!cmd) throw new Error(`Unknown zone: ${zone}`);
  const hex = clamped.toString(16).toUpperCase().padStart(2, '0');
  await sendISCP(`${cmd}${hex}`);
  zoneVolume[zone] = clamped;
  broadcast({ type: 'volumeUpdate', zone, volume: clamped });
  return clamped;
}

// ── Fog helpers ───────────────────────────────────────────────────────────────
async function fogOn() {
  console.log('[FOG] on');
  fogActive = true;
  broadcast({ type: 'fogStatus', active: true });
  await sendISCP('TGA01');
}

async function fogOff() {
  console.log('[FOG] off');
  fogActive = false;
  broadcast({ type: 'fogStatus', active: false });
  await sendISCP('TGA00');
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ── Storm engine ──────────────────────────────────────────────────────────────
const STORM_PRESETS = {
  distant:    { minMs: 3 * 60000, maxMs: 5 * 60000, fogChance: 0.1, volume: 20 },
  moving:     { minMs: 2 * 60000, maxMs: 3 * 60000, fogChance: 0.3, volume: 35 },
  ontop:      { minMs: 30000,     maxMs: 90000,      fogChance: 0.6, volume: 55 },
};

function scheduleNextStrike() {
  if (!stormActive) return;
  const preset = STORM_PRESETS[stormPreset] || STORM_PRESETS.distant;
  const delay  = preset.minMs + Math.random() * (preset.maxMs - preset.minMs);
  console.log(`[STORM] Next strike in ${Math.round(delay / 1000)}s`);
  stormTimer = setTimeout(fireStrike, delay);
}

async function fireStrike() {
  if (!stormActive) return;
  console.log('[STORM] Strike!');
  broadcast({ type: 'lightningStrike' });

  const preset = STORM_PRESETS[stormPreset] || STORM_PRESETS.distant;
  try {
    await setZoneVolume('z1', preset.volume);
    if (Math.random() < preset.fogChance) {
      await fogOn();
      setTimeout(fogOff, 4000);
    }
  } catch (e) {
    console.error('[STORM] strike error:', e.message);
  }

  scheduleNextStrike();
}

function stopStorm() {
  stormActive = false;
  if (stormTimer) { clearTimeout(stormTimer); stormTimer = null; }
  broadcast({ type: 'stormStatus', active: false });
  console.log('[STORM] stopped');
}

// ── Startup connection test ───────────────────────────────────────────────────
async function testConnection() {
  try {
    await sendISCP('PWRQSTN'); // query power status
    receiverOnline = true;
    console.log('[STARTUP] Receiver online');
  } catch (e) {
    receiverOnline = false;
    console.warn('[STARTUP] Receiver offline:', e.message);
  }
  broadcast({ type: 'receiverStatus', online: receiverOnline });
}

// ── API routes ────────────────────────────────────────────────────────────────

// Raw ISCP command
app.post('/api/onkyo/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  console.log(`[API] /command: ${command}`);
  try {
    const resp = await sendISCP(command);
    res.json({ ok: true, response: resp });
  } catch (e) {
    console.error('[API] command error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Volume with cap enforcement
app.post('/api/onkyo/volume', async (req, res) => {
  const { zone, volume } = req.body;
  if (!zone || volume === undefined) return res.status(400).json({ error: 'zone and volume required' });
  console.log(`[API] /volume zone=${zone} vol=${volume}`);
  try {
    const set = await setZoneVolume(zone, volume);
    res.json({ ok: true, zone, volume: set });
  } catch (e) {
    console.error('[API] volume error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fog fire
app.post('/api/fog/fire', async (req, res) => {
  const duration = Number(req.body.duration) || 5000;
  console.log(`[API] /fog/fire duration=${duration}ms`);
  try {
    await fogOn();
    if (fogTimer) clearTimeout(fogTimer);
    fogTimer = setTimeout(fogOff, duration);
    res.json({ ok: true, duration });
  } catch (e) {
    console.error('[API] fog/fire error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fog stop
app.post('/api/fog/stop', async (req, res) => {
  console.log('[API] /fog/stop');
  if (fogTimer) { clearTimeout(fogTimer); fogTimer = null; }
  try {
    await fogOff();
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] fog/stop error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Mute zone
app.post('/api/onkyo/mute', async (req, res) => {
  const { zone, mute } = req.body;
  console.log(`[API] /mute zone=${zone} mute=${mute}`);
  const MUTE_CMD = { z1: 'AMT', z2: 'ZMT', z3: 'MT3' };
  const cmd = MUTE_CMD[zone];
  if (!cmd) return res.status(400).json({ error: 'unknown zone' });
  try {
    await sendISCP(`${cmd}${mute ? '01' : '00'}`);
    zoneMute[zone] = !!mute;
    broadcast({ type: 'muteUpdate', zone, mute: zoneMute[zone] });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Storm control
app.post('/api/storm/start', async (req, res) => {
  stormPreset = req.body.preset || 'distant';
  stormActive = true;
  broadcast({ type: 'stormStatus', active: true, preset: stormPreset });
  scheduleNextStrike();
  console.log(`[API] storm start preset=${stormPreset}`);
  res.json({ ok: true, preset: stormPreset });
});

app.post('/api/storm/stop', (req, res) => {
  stopStorm();
  res.json({ ok: true });
});

app.post('/api/storm/strike', async (req, res) => {
  console.log('[API] manual strike');
  broadcast({ type: 'lightningStrike' });
  res.json({ ok: true });
  try { await setZoneVolume('z1', 50); } catch (e) { /* best effort */ }
});

// Config update
app.post('/api/config', (req, res) => {
  const { receiverIp, receiverPort, maxCaps } = req.body;
  if (receiverIp)   config.receiverIp   = receiverIp;
  if (receiverPort) config.receiverPort = Number(receiverPort);
  if (maxCaps)      Object.assign(config.maxCaps, maxCaps);
  console.log('[API] config updated', config);
  res.json({ ok: true, config });
  testConnection();
});

// Status
app.get('/api/status', (req, res) => {
  res.json({
    receiverOnline,
    config,
    zoneVolume,
    zoneMute,
    fogActive,
    stormActive,
    stormPreset,
  });
});

// Scene presets
const SCENES = {
  ambient:    { z1: 25, z2: 20, z3: 15 },
  active:     { z1: 45, z2: 35, z3: 30 },
  peakscare:  { z1: 60, z2: 55, z3: 50 },
  quiet:      { z1: 15, z2: 10, z3: 10 },
  battle:     { z1: 65, z2: 60, z3: 55 },
};

app.post('/api/scene', async (req, res) => {
  const { scene } = req.body;
  const vols = SCENES[scene];
  if (!vols) return res.status(400).json({ error: 'unknown scene' });
  console.log(`[API] scene: ${scene}`);
  try {
    await Promise.all([
      setZoneVolume('z1', vols.z1),
      setZoneVolume('z2', vols.z2),
      setZoneVolume('z3', vols.z3),
    ]);
    res.json({ ok: true, scene });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All stop
app.post('/api/allstop', async (req, res) => {
  console.log('[API] ALL STOP');
  stopStorm();
  if (fogTimer) { clearTimeout(fogTimer); fogTimer = null; }
  try {
    await fogOff();
    await Promise.all([
      sendISCP('MVL00'),
      sendISCP('ZVL00'),
      sendISCP('VL300'),
    ]);
    zoneVolume.z1 = 0; zoneVolume.z2 = 0; zoneVolume.z3 = 0;
    broadcast({ type: 'volumeUpdate', zone: 'z1', volume: 0 });
    broadcast({ type: 'volumeUpdate', zone: 'z2', volume: 0 });
    broadcast({ type: 'volumeUpdate', zone: 'z3', volume: 0 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pause (mute all)
app.post('/api/pause', async (req, res) => {
  console.log('[API] PAUSE');
  try {
    await Promise.all([
      sendISCP('AMT01'),
      sendISCP('ZMT01'),
      sendISCP('MT301'),
    ]);
    zoneMute.z1 = true; zoneMute.z2 = true; zoneMute.z3 = true;
    broadcast({ type: 'muteUpdate', zone: 'all', mute: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resume (unmute all)
app.post('/api/resume', async (req, res) => {
  console.log('[API] RESUME');
  try {
    await Promise.all([
      sendISCP('AMT00'),
      sendISCP('ZMT00'),
      sendISCP('MT300'),
    ]);
    zoneMute.z1 = false; zoneMute.z2 = false; zoneMute.z3 = false;
    broadcast({ type: 'muteUpdate', zone: 'all', mute: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kid Mode
app.post('/api/kidmode', async (req, res) => {
  console.log('[API] KID MODE');
  stopStorm();
  try {
    await Promise.all([
      setZoneVolume('z1', 30),
      setZoneVolume('z2', 25),
      setZoneVolume('z3', 20),
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Neighbor Battle Mode
app.post('/api/battlemode', async (req, res) => {
  console.log('[API] BATTLE MODE');
  stormPreset = 'ontop';
  stormActive = true;
  scheduleNextStrike();
  try {
    await Promise.all([
      setZoneVolume('z1', config.maxCaps.z1),
      setZoneVolume('z2', config.maxCaps.z2),
      setZoneVolume('z3', config.maxCaps.z3),
    ]);
    broadcast({ type: 'stormStatus', active: true, preset: 'ontop' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Character triggers
const CHARACTER_PRESETS = {
  reaper:     { z1: 55, z2: 50, z3: 45, fogDuration: 6000 },
  horseman:   { z1: 50, z2: 45, z3: 40, fogDuration: 5000 },
  pumpkinking:{ z1: 45, z2: 40, z3: 35, fogDuration: 4000 },
};

app.post('/api/character/:name', async (req, res) => {
  const preset = CHARACTER_PRESETS[req.params.name];
  if (!preset) return res.status(400).json({ error: 'unknown character' });
  console.log(`[API] character trigger: ${req.params.name}`);
  broadcast({ type: 'characterTrigger', character: req.params.name });
  try {
    await Promise.all([
      setZoneVolume('z1', preset.z1),
      setZoneVolume('z2', preset.z2),
      setZoneVolume('z3', preset.z3),
    ]);
    await fogOn();
    if (fogTimer) clearTimeout(fogTimer);
    fogTimer = setTimeout(fogOff, preset.fogDuration);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] client connected');
  ws.send(JSON.stringify({
    type: 'init',
    receiverOnline,
    config,
    zoneVolume,
    zoneMute,
    fogActive,
    stormActive,
    stormPreset,
  }));
});

// ── Auto witch timer ──────────────────────────────────────────────────────────
function scheduleWitch() {
  const delay = (120 + Math.random() * 60) * 1000; // 2-3 min
  setTimeout(async () => {
    console.log('[WITCH] auto fire');
    broadcast({ type: 'witchSound' });
    scheduleWitch();
  }, delay);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = 8080;
server.listen(PORT, () => {
  console.log(`[HAUNT CTRL v3] listening on http://localhost:${PORT}`);
  testConnection();
  scheduleWitch();
});
