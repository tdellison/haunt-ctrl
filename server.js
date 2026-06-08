const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const net = require('net');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config (mutable via /api/config) ────────────────────────────────────────
let config = {
  receiverIp: '192.168.1.190',
  receiverPort: 60128,
  maxVol: { z1: 65, z2: 60, z3: 55 },
};

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  connected: false,
  fogActive: false,
  fogTimer: null,
  stormActive: false,
  stormTimer: null,
  stormPreset: 'distant',
  kidMode: false,
  paused: false,
  volumes: { z1: 30, z2: 25, z3: 20 },
  mute: { z1: false, z2: false, z3: false },
};

// ─── ISCP Packet Builder ──────────────────────────────────────────────────────
function buildISCPPacket(command) {
  // ISCP message body: !1{COMMAND}\r\n
  const msgBody = `!1${command}\r\n`;
  const msgBytes = Buffer.from(msgBody, 'ascii');

  // 16-byte header
  const header = Buffer.alloc(16);
  header.write('ISCP', 0, 'ascii');          // magic
  header.writeUInt32BE(16, 4);               // header size
  header.writeUInt32BE(msgBytes.length, 8);  // data size
  header.writeUInt8(1, 12);                  // version
  header.writeUInt8(0, 13);                  // reserved
  header.writeUInt8(0, 14);                  // reserved
  header.writeUInt8(0, 15);                  // reserved

  return Buffer.concat([header, msgBytes]);
}

// ─── Send ISCP Command ────────────────────────────────────────────────────────
function sendISCP(command) {
  return new Promise((resolve, reject) => {
    const packet = buildISCPPacket(command);
    const sock = new net.Socket();
    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error('ISCP timeout'));
    }, 3000);

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

    sock.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[ISCP] Error: ${err.message}`);
      reject(err);
    });

    sock.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// ─── Connection Test ──────────────────────────────────────────────────────────
async function testConnection() {
  try {
    await sendISCP('PWRQSTN');
    state.connected = true;
    console.log('[HAUNT] Receiver connected');
  } catch (e) {
    state.connected = false;
    console.warn(`[HAUNT] Receiver unreachable: ${e.message}`);
  }
  broadcastState();
}

// ─── WebSocket Broadcast ──────────────────────────────────────────────────────
function broadcastState() {
  const payload = JSON.stringify({ type: 'state', data: state });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function broadcastLog(msg) {
  const payload = JSON.stringify({ type: 'log', msg });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
  console.log(`[LOG] ${msg}`);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', data: state }));
  ws.send(JSON.stringify({ type: 'config', data: config }));
});

// ─── Volume Helpers ───────────────────────────────────────────────────────────
function clampVol(zone, val) {
  const cap = config.maxVol[zone];
  return Math.max(0, Math.min(cap, val));
}

function volToHex(v) {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

// Zone 1 = MVL, Zone 2 = ZVL, Zone 3 = Z3L
const ZONE_CMD = { z1: 'MVL', z2: 'ZVL', z3: 'Z3L' };
const MUTE_CMD = { z1: 'AMT', z2: 'ZMT', z3: 'MT3' };

// ─── Fog Helpers ──────────────────────────────────────────────────────────────
async function fogOn() {
  await sendISCP('TGA01');
  state.fogActive = true;
  broadcastState();
  broadcastLog('Fog ON');
}

async function fogOff() {
  if (state.fogTimer) { clearTimeout(state.fogTimer); state.fogTimer = null; }
  await sendISCP('TGA00');
  state.fogActive = false;
  broadcastState();
  broadcastLog('Fog OFF');
}

// ─── Storm Engine ─────────────────────────────────────────────────────────────
const STORM_PRESETS = {
  distant:  { minMs: 180000, maxMs: 300000, vol: 35, fog: false },
  movingin: { minMs: 120000, maxMs: 180000, vol: 50, fog: false },
  ontop:    { minMs:  30000, maxMs:  90000, vol: 65, fog: true  },
};

function scheduleNextStrike() {
  if (!state.stormActive) return;
  const p = STORM_PRESETS[state.stormPreset] || STORM_PRESETS.distant;
  const delay = p.minMs + Math.random() * (p.maxMs - p.minMs);
  broadcastLog(`Storm: next strike in ${Math.round(delay / 1000)}s`);
  state.stormTimer = setTimeout(async () => {
    if (!state.stormActive || state.paused) return scheduleNextStrike();
    broadcastLog('Storm: STRIKE!');
    try {
      // Thunder rumble on zone 1
      const v = clampVol('z1', p.vol);
      await sendISCP(`${ZONE_CMD.z1}${volToHex(v)}`);
      // Lights flash
      broadcastState();
      if (p.fog) { await fogOn(); state.fogTimer = setTimeout(fogOff, 4000); }
    } catch (e) {
      broadcastLog(`Storm strike error: ${e.message}`);
    }
    scheduleNextStrike();
  }, delay);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Raw ISCP command
app.post('/api/onkyo/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  console.log(`[API] /api/onkyo/command command=${command}`);
  broadcastLog(`ISCP: ${command}`);
  try {
    const resp = await sendISCP(command);
    state.connected = true;
    res.json({ ok: true, response: resp });
  } catch (e) {
    state.connected = false;
    broadcastState();
    res.status(502).json({ error: e.message });
  }
});

// Zone volume
app.post('/api/onkyo/volume', async (req, res) => {
  const { zone, value } = req.body;
  if (!zone || value === undefined) return res.status(400).json({ error: 'zone and value required' });
  const z = zone.toLowerCase();
  if (!ZONE_CMD[z]) return res.status(400).json({ error: 'zone must be z1/z2/z3' });
  const clamped = clampVol(z, parseInt(value, 10));
  const cmd = `${ZONE_CMD[z]}${volToHex(clamped)}`;
  console.log(`[API] /api/onkyo/volume zone=${z} requested=${value} clamped=${clamped} cmd=${cmd}`);
  broadcastLog(`Volume ${z.toUpperCase()}=${clamped}${clamped < parseInt(value, 10) ? ' (capped)' : ''}`);
  try {
    await sendISCP(cmd);
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

// Mute zone
app.post('/api/onkyo/mute', async (req, res) => {
  const { zone, mute } = req.body;
  if (!zone || mute === undefined) return res.status(400).json({ error: 'zone and mute required' });
  const z = zone.toLowerCase();
  if (!MUTE_CMD[z]) return res.status(400).json({ error: 'zone must be z1/z2/z3' });
  const cmd = `${MUTE_CMD[z]}${mute ? '01' : '00'}`;
  console.log(`[API] /api/onkyo/mute zone=${z} mute=${mute} cmd=${cmd}`);
  broadcastLog(`Mute ${z.toUpperCase()}=${mute}`);
  try {
    await sendISCP(cmd);
    state.mute[z] = mute;
    broadcastState();
    res.json({ ok: true, zone: z, mute });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Fire fog
app.post('/api/fog/fire', async (req, res) => {
  const { duration = 5000 } = req.body;
  console.log(`[API] /api/fog/fire duration=${duration}ms`);
  try {
    await fogOn();
    if (state.fogTimer) clearTimeout(state.fogTimer);
    state.fogTimer = setTimeout(fogOff, Math.min(duration, 30000));
    res.json({ ok: true, duration });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Stop fog
app.post('/api/fog/stop', async (req, res) => {
  console.log('[API] /api/fog/stop');
  try {
    await fogOff();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// All stop
app.post('/api/allstop', async (req, res) => {
  console.log('[API] /api/allstop');
  broadcastLog('ALL STOP');
  state.paused = false;
  try {
    await Promise.allSettled([
      fogOff(),
      sendISCP(`${ZONE_CMD.z1}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(0)}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(0)}`),
    ]);
    state.volumes = { z1: 0, z2: 0, z3: 0 };
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Pause / resume
app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  console.log(`[API] /api/pause paused=${state.paused}`);
  broadcastLog(state.paused ? 'PAUSED' : 'RESUMED');
  broadcastState();
  res.json({ ok: true, paused: state.paused });
});

// Kid mode
app.post('/api/kidmode', async (req, res) => {
  state.kidMode = !state.kidMode;
  console.log(`[API] /api/kidmode kidMode=${state.kidMode}`);
  broadcastLog(`Kid Mode ${state.kidMode ? 'ON' : 'OFF'}`);
  try {
    if (state.kidMode) {
      // Lower volumes, stop fog
      await Promise.allSettled([
        fogOff(),
        sendISCP(`${ZONE_CMD.z1}${volToHex(clampVol('z1', 30))}`),
        sendISCP(`${ZONE_CMD.z2}${volToHex(clampVol('z2', 25))}`),
        sendISCP(`${ZONE_CMD.z3}${volToHex(clampVol('z3', 20))}`),
      ]);
    }
    broadcastState();
    res.json({ ok: true, kidMode: state.kidMode });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Neighbor battle mode
app.post('/api/battlemode', async (req, res) => {
  console.log('[API] /api/battlemode');
  broadcastLog('NEIGHBOR BATTLE MODE');
  state.kidMode = false;
  try {
    await Promise.allSettled([
      sendISCP(`${ZONE_CMD.z1}${volToHex(config.maxVol.z1)}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(config.maxVol.z2)}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(config.maxVol.z3)}`),
      fogOn(),
    ]);
    state.volumes = { z1: config.maxVol.z1, z2: config.maxVol.z2, z3: config.maxVol.z3 };
    if (state.fogTimer) clearTimeout(state.fogTimer);
    state.fogTimer = setTimeout(fogOff, 10000);
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Scene preset
app.post('/api/scene', async (req, res) => {
  const { scene } = req.body;
  console.log(`[API] /api/scene scene=${scene}`);
  const scenes = {
    ambient:   { z1: 35, z2: 30, z3: 25, fog: false },
    active:    { z1: 45, z2: 40, z3: 35, fog: false },
    peakscare: { z1: 60, z2: 55, z3: 50, fog: true  },
    quiet:     { z1: 20, z2: 15, z3: 15, fog: false },
    battle:    { z1: 65, z2: 60, z3: 55, fog: true  },
  };
  const s = scenes[scene?.toLowerCase().replace(/\s/g, '')];
  if (!s) return res.status(400).json({ error: 'unknown scene' });
  broadcastLog(`Scene: ${scene}`);
  try {
    await Promise.allSettled([
      sendISCP(`${ZONE_CMD.z1}${volToHex(clampVol('z1', s.z1))}`),
      sendISCP(`${ZONE_CMD.z2}${volToHex(clampVol('z2', s.z2))}`),
      sendISCP(`${ZONE_CMD.z3}${volToHex(clampVol('z3', s.z3))}`),
      s.fog ? fogOn() : fogOff(),
    ]);
    state.volumes = {
      z1: clampVol('z1', s.z1),
      z2: clampVol('z2', s.z2),
      z3: clampVol('z3', s.z3),
    };
    broadcastState();
    res.json({ ok: true, scene });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Character trigger (graveyard)
app.post('/api/character', async (req, res) => {
  const { character } = req.body;
  console.log(`[API] /api/character character=${character}`);
  const chars = {
    grimreaper:       { z1: 55, fog: true,  fogDur: 6000 },
    headlesshorseman: { z1: 60, fog: true,  fogDur: 8000 },
    pumpkinking:      { z1: 50, fog: false, fogDur: 0    },
  };
  const c = chars[character?.toLowerCase().replace(/\s/g, '')];
  if (!c) return res.status(400).json({ error: 'unknown character' });
  broadcastLog(`Character trigger: ${character}`);
  try {
    await sendISCP(`${ZONE_CMD.z1}${volToHex(clampVol('z1', c.z1))}`);
    if (c.fog) {
      await fogOn();
      if (state.fogTimer) clearTimeout(state.fogTimer);
      state.fogTimer = setTimeout(fogOff, c.fogDur);
    }
    state.volumes.z1 = clampVol('z1', c.z1);
    broadcastState();
    res.json({ ok: true, character });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Storm control
app.post('/api/storm/toggle', (req, res) => {
  const { preset } = req.body;
  state.stormActive = !state.stormActive;
  if (preset) state.stormPreset = preset;
  console.log(`[API] /api/storm/toggle active=${state.stormActive} preset=${state.stormPreset}`);
  broadcastLog(`Storm ${state.stormActive ? 'ON' : 'OFF'} [${state.stormPreset}]`);
  if (state.stormActive) {
    scheduleNextStrike();
  } else {
    if (state.stormTimer) { clearTimeout(state.stormTimer); state.stormTimer = null; }
  }
  broadcastState();
  res.json({ ok: true, stormActive: state.stormActive, preset: state.stormPreset });
});

app.post('/api/storm/strike', async (req, res) => {
  console.log('[API] /api/storm/strike manual');
  broadcastLog('Manual lightning strike!');
  try {
    const v = clampVol('z1', 65);
    await sendISCP(`${ZONE_CMD.z1}${volToHex(v)}`);
    state.volumes.z1 = v;
    broadcastState();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Witch auto-fire (called client-side timer, server executes)
app.post('/api/graveyard/witch', async (req, res) => {
  console.log('[API] /api/graveyard/witch auto-fire');
  broadcastLog('Witch sound trigger');
  try {
    // Brief z2 bump for witch ambient
    const v = clampVol('z2', state.volumes.z2 + 5);
    await sendISCP(`${ZONE_CMD.z2}${volToHex(v)}`);
    setTimeout(async () => {
      try {
        await sendISCP(`${ZONE_CMD.z2}${volToHex(state.volumes.z2)}`);
      } catch (_) {}
    }, 3000);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Config update
app.post('/api/config', (req, res) => {
  const { receiverIp, receiverPort, maxVol } = req.body;
  if (receiverIp) config.receiverIp = receiverIp;
  if (receiverPort) config.receiverPort = parseInt(receiverPort, 10);
  if (maxVol) {
    if (maxVol.z1 !== undefined) config.maxVol.z1 = Math.min(80, parseInt(maxVol.z1, 10));
    if (maxVol.z2 !== undefined) config.maxVol.z2 = Math.min(80, parseInt(maxVol.z2, 10));
    if (maxVol.z3 !== undefined) config.maxVol.z3 = Math.min(80, parseInt(maxVol.z3, 10));
  }
  console.log(`[API] /api/config updated`, config);
  broadcastLog('Config updated');
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'config', data: config })); });
  res.json({ ok: true, config });
});

// Config connect test
app.post('/api/connect', async (req, res) => {
  console.log(`[API] /api/connect testing ${config.receiverIp}:${config.receiverPort}`);
  broadcastLog(`Connecting to ${config.receiverIp}:${config.receiverPort}…`);
  await testConnection();
  res.json({ ok: true, connected: state.connected });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 8080;
server.listen(PORT, () => {
  console.log(`[HAUNT] HAUNT CTRL v3 running on http://localhost:${PORT}`);
  testConnection();
});
