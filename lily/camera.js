// ─── Lily's camera — she notices costumes ─────────────────────────────────────
//
// A webcam dedicated to Lily (Halloween show). The PIRs still decide WHEN
// someone is there; this decides what she can SAY about them: when her PIR
// fires she greets as usual, and meanwhile one frame goes to Claude (Haiku,
// vision) for a short description of the costumes. The description comes back
// to talk.js, which has her react to it in character right after the greeting.
//
// Cross-platform: v4l2 on Linux (the OptiPlex), dshow on Windows (the Dell).
// One ffmpeg owns the webcam: pipe 1 = 2 fps 640-wide JPEGs (latest kept in
// memory, never written to disk), pipe 3 = a 16×12 grey thumbnail per frame
// for a brightness reading. Too dark (night, no IR) = no Claude call at all —
// daylight is when this earns its keep.
//
// Settings per machine in lily-camera.json (gitignored): { enabled, device,
// minBrightness, chance }.

'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'lily-camera.json');
const MODEL = 'claude-haiku-4-5';
const THUMB = 16 * 12;
const IS_WINDOWS = process.platform === 'win32';

const PROMPT = [
  'You are the eyes of Lethal Lily, a lantern-carrying skeleton who is the MC of a Halloween yard haunt. ' +
  'Describe, for her, what the people in this camera picture are WEARING: costumes, characters, masks, hats, ' +
  'props, face paint, a fun shirt or a slogan on it. One short sentence, under 25 words, concrete (e.g. "two ' +
  'small kids, one a pirate with a hook, one a pink unicorn; an adult in a Steelers jersey").',
  'Rules: clothing, costumes and props ONLY — never describe faces, bodies, size, age beyond "small kid / ' +
  'adult", skin, gender, hair or disability, and never guess who someone is. Skip rude or political slogans. ' +
  'If nobody is clearly visible, or the picture is too dark or blurry, return an empty string.',
].join('\n\n');

function listCameras(ffmpegBin) {
  if (!IS_WINDOWS) {
    try {
      return Promise.resolve(fs.readdirSync('/sys/class/video4linux')
        .filter(d => d.startsWith('video'))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .map(d => {
          let name = d;
          try { name = fs.readFileSync(`/sys/class/video4linux/${d}/name`, 'utf8').trim(); } catch (_) {}
          return { device: `/dev/${d}`, name };
        }));
    } catch (_) { return Promise.resolve([]); }
  }
  // Windows: ffmpeg lists DirectShow cameras on stderr.
  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 8000 }, (err, out, errOut) => {
      const names = [...String(errOut || '').matchAll(/"([^"]+)"\s*\(video\)/g)].map(m => m[1]);
      resolve(names.map(n => ({ device: n, name: n })));
    });
  });
}

function createLilyCamera({ log = console.log, getApiKey, trackTokens = () => {}, ffmpegBin = 'ffmpeg' }) {
  let settings = { enabled: false, device: '', minBrightness: 35, chance: 1 };
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { log(`camera settings save failed: ${e.message}`); } };

  const status = { running: false, device: null, brightness: null, lastError: null, lastSeen: null, lastSeenAt: null };
  let proc = null, wanted = false, restartTimer = null;
  let jpegBuf = Buffer.alloc(0), latest = null, latestAt = 0, thumbBuf = Buffer.alloc(0);
  let client = null;
  // Ask for 720p MJPEG (Linux): a 4K camera's full frames are wasted work —
  // everything is scaled to 640 wide. If it refuses, fall back to its default.
  let askedMode = true;

  function onJpeg(d) {
    jpegBuf = jpegBuf.length ? Buffer.concat([jpegBuf, d]) : d;
    for (;;) {
      const start = jpegBuf.indexOf(Buffer.from([0xFF, 0xD8]));
      if (start < 0) { jpegBuf = Buffer.alloc(0); return; }
      const end = jpegBuf.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
      if (end < 0) { if (start) jpegBuf = jpegBuf.subarray(start); return; }
      latest = Buffer.from(jpegBuf.subarray(start, end + 2));
      latestAt = Date.now();
      jpegBuf = jpegBuf.subarray(end + 2);
    }
  }
  function onThumb(d) {
    thumbBuf = thumbBuf.length ? Buffer.concat([thumbBuf, d]) : d;
    while (thumbBuf.length >= THUMB) {
      let sum = 0;
      for (let i = 0; i < THUMB; i++) sum += thumbBuf[i];
      status.brightness = Math.round(sum / THUMB);
      thumbBuf = thumbBuf.subarray(THUMB);
    }
  }

  async function start() {
    wanted = true;
    if (proc) return;
    const dev = settings.device || ((await listCameras(ffmpegBin))[0] || {}).device;
    if (!dev) {
      if (status.lastError !== 'No camera found') log('Lily camera: no camera found — will keep checking');
      status.lastError = 'No camera found';
      return scheduleRestart();
    }
    const input = dev.startsWith('lavfi:') ? ['-re', '-f', 'lavfi', '-i', dev.slice(6)]
      : IS_WINDOWS ? ['-f', 'dshow', '-i', `video=${dev}`]
      : askedMode ? ['-f', 'v4l2', '-input_format', 'mjpeg', '-video_size', '1280x720', '-framerate', '15', '-i', dev]
      : ['-f', 'v4l2', '-i', dev];
    const args = ['-hide_banner', '-loglevel', 'error', ...input,
      '-filter_complex', '[0:v]fps=2,split=2[a][b];[a]scale=640:-2,format=yuvj420p[j];[b]scale=16:12,format=gray[t]',
      '-map', '[j]', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1',
      '-map', '[t]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:3'];
    jpegBuf = Buffer.alloc(0); thumbBuf = Buffer.alloc(0);
    status.device = dev;
    proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    status.running = true;
    if (!status.lastError) log(`Lily camera: watching ${dev}`);
    let errText = '';
    proc.stdout.on('data', (d) => { if (status.lastError) status.lastError = null; onJpeg(d); });
    proc.stdio[3].on('data', onThumb);
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-300); });
    proc.on('error', (e) => { status.lastError = e.message; });
    proc.on('exit', (code) => {
      proc = null; status.running = false;
      if (wanted) {
        const err = errText.trim() || `ffmpeg exited (${code})`;
        if (askedMode && !IS_WINDOWS && !dev.startsWith('lavfi:') && !/No such file|busy|Permission denied/i.test(err)) { askedMode = false; log('Lily camera: 720p MJPEG refused — using the camera\'s default mode'); }
        else if (err !== status.lastError) log(`Lily camera stopped: ${err} — retrying every 10 s`);
        status.lastError = err;
        scheduleRestart();
      }
    });
  }
  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { if (wanted) start(); }, 10000);
  }
  function stop() {
    wanted = false;
    clearTimeout(restartTimer);
    if (proc) proc.kill();
    status.brightness = null;
  }

  function anthropic() {
    const key = getApiKey();
    if (!key) throw new Error('No Anthropic API key');
    if (!client || client._key !== key) {
      const A = require('@anthropic-ai/sdk');
      client = new (A.default || A)({ apiKey: key, timeout: 8000, maxRetries: 0 });
      client._key = key;
    }
    return client;
  }

  // What are the guests in front of her wearing? -> sentence, or null.
  // force = the LOOK NOW test button (ignores the chance roll, not the dark check).
  async function look({ force = false } = {}) {
    if (!settings.enabled || !status.running) return null;
    if (!force && Math.random() >= settings.chance) return null;
    if (!latest || Date.now() - latestAt > 3000) throw new Error('No fresh camera picture');
    if (status.brightness !== null && status.brightness < settings.minBrightness) {
      log(`Lily camera: too dark to see costumes (brightness ${status.brightness} < ${settings.minBrightness})`);
      return null;
    }
    const t0 = Date.now();
    const response = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 200,
      output_config: { format: { type: 'json_schema', schema: {
        type: 'object', properties: { wearing: { type: 'string' } }, required: ['wearing'], additionalProperties: false,
      } } },
      system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: latest.toString('base64') } },
        { type: 'text', text: 'The guests in front of Lily right now.' },
      ] }],
    });
    trackTokens(response.model || MODEL, response.usage?.input_tokens, response.usage?.output_tokens);
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const wearing = String(JSON.parse(text).wearing || '').trim() || null;
    status.lastSeen = wearing || '(nothing she could make out)';
    status.lastSeenAt = new Date().toISOString();
    log(`Lily camera: ${wearing ? `sees ${wearing}` : 'nothing to remark on'} (${Date.now() - t0} ms)`);
    return wearing;
  }

  return {
    start, stop, look,
    list: () => listCameras(ffmpegBin),
    snapshot: () => latest,
    settings: () => ({ ...settings }),
    configure(patch = {}) {
      const before = JSON.stringify([settings.enabled, settings.device]);
      if (patch.enabled !== undefined) settings.enabled = !!patch.enabled;
      if (patch.device !== undefined) settings.device = String(patch.device || '');
      if (patch.minBrightness !== undefined) settings.minBrightness = Math.max(0, Math.min(255, Number(patch.minBrightness) || 0));
      if (patch.chance !== undefined) settings.chance = Math.max(0, Math.min(1, Number(patch.chance)));
      save();
      if (JSON.stringify([settings.enabled, settings.device]) !== before) {
        stop();
        if (settings.enabled) setTimeout(start, 500);
      }
      return { ...settings };
    },
    status: () => ({ ...status, ...settings, hasPicture: !!latest && Date.now() - latestAt < 3000 }),
  };
}

module.exports = { createLilyCamera };
