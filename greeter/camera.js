// ─── Greeter camera — the USB webcam as the arrival sensor ────────────────────
//
// ffmpeg reads the webcam (v4l2), scales every frame down to 160x120 grey and
// pipes raw bytes here. Each frame is compared to a slowly-updating background;
// the share of pixels that changed INSIDE the detection box is the motion
// level. Enough motion for a few frames in a row, after the box was quiet,
// is an "arrival".
//
// The background keeps adapting, so a person who stops in view fades into it
// after a few seconds and does not keep re-triggering, and slow light changes
// (sun, office lights) are absorbed instead of counting as motion.
//
// Pure Node + ffmpeg: no OpenCV, no native modules. A face/person recogniser
// can sit on top later via shouldIgnore(frame) without changing this file's
// callers.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const W = 160, H = 120, PIXELS = W * H;

function listCameras() {
  try {
    return fs.readdirSync('/sys/class/video4linux')
      .filter(d => d.startsWith('video'))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map(d => {
        let name = d;
        try { name = fs.readFileSync(`/sys/class/video4linux/${d}/name`, 'utf8').trim(); } catch (_) {}
        return { device: `/dev/${d}`, name };
      });
  } catch (_) { return []; }
}

// 8-bit greyscale BMP (palette) — the browser shows it directly, no encoder needed.
function toBmp(gray, box) {
  const img = Buffer.from(gray);
  if (box) {
    const x0 = Math.round(box.x0 * (W - 1)), x1 = Math.round(box.x1 * (W - 1));
    const y0 = Math.round(box.y0 * (H - 1)), y1 = Math.round(box.y1 * (H - 1));
    for (let x = x0; x <= x1; x++) { img[y0 * W + x] = 255; img[y1 * W + x] = 255; }
    for (let y = y0; y <= y1; y++) { img[y * W + x0] = 255; img[y * W + x1] = 255; }
  }
  const head = Buffer.alloc(14 + 40 + 1024);
  head.write('BM', 0);
  head.writeUInt32LE(head.length + PIXELS, 2);
  head.writeUInt32LE(head.length, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(W, 18);
  head.writeInt32LE(-H, 22);           // negative = top-down rows
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(8, 28);
  head.writeUInt32LE(256, 46);
  for (let i = 0; i < 256; i++) head.writeUInt32LE((i << 16) | (i << 8) | i, 54 + i * 4);
  return Buffer.concat([head, img]);   // W is a multiple of 4, so no row padding
}

function createCamera({ log = console.log, getConfig, onArrival = () => {}, shouldIgnore = () => false }) {
  const status = { running: false, device: null, level: 0, lastArrival: null, lastError: null, frames: 0 };
  let proc = null, wanted = false, restartTimer = null;
  let bg = null, latest = null, pending = Buffer.alloc(0);
  let hotFrames = 0, quietFrames = 999, armedForNext = true;

  function processFrame(frame) {
    const c = getConfig().camera;
    latest = frame;
    status.frames++;
    if (!bg) { bg = Float32Array.from(frame); return; }
    const x0 = Math.floor(c.box.x0 * W), x1 = Math.ceil(c.box.x1 * W);
    const y0 = Math.floor(c.box.y0 * H), y1 = Math.ceil(c.box.y1 * H);
    let changed = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        total++;
        if (Math.abs(frame[i] - bg[i]) > c.pixelDelta) changed++;
      }
    }
    for (let i = 0; i < PIXELS; i++) bg[i] += (frame[i] - bg[i]) * c.adapt;
    const level = total ? changed / total : 0;
    status.level = Math.round(level * 1000) / 1000;

    if (level >= c.minArea) { hotFrames++; quietFrames = 0; }
    else { hotFrames = 0; quietFrames++; }
    // Re-arm only after the box has been quiet for a moment, so one person
    // walking through counts once, not once per burst of motion.
    if (quietFrames >= c.quietFramesToRearm) armedForNext = true;
    if (armedForNext && hotFrames >= c.framesToTrigger) {
      armedForNext = false;
      if (shouldIgnore(frame)) { log('camera: motion ignored'); return; }
      status.lastArrival = new Date().toISOString();
      onArrival({ level });
    }
  }

  function start() {
    wanted = true;
    if (proc) return;
    const c = getConfig().camera;
    const dev = c.device || (listCameras()[0] || {}).device;
    if (!dev) {
      if (status.lastError !== 'No webcam found (/dev/video*)') log('camera: no webcam found (/dev/video*) — will keep checking');
      status.lastError = 'No webcam found (/dev/video*)';
      scheduleRestart(); return;
    }
    // "lavfi:<graph>" feeds a synthetic source — used for testing without a webcam.
    const input = dev.startsWith('lavfi:') ? ['-re', '-f', 'lavfi', '-i', dev.slice(6)] : ['-f', 'v4l2', '-i', dev];
    const args = ['-loglevel', 'error', ...input,
      '-vf', `fps=${c.fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
    bg = null; pending = Buffer.alloc(0); hotFrames = 0; quietFrames = 999; armedForNext = true;
    status.device = dev;
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    status.running = true;
    if (!status.lastError) log(`camera: watching ${dev}`);
    let errText = '';
    proc.stderr.on('data', d => { errText = (errText + d).slice(-300); });
    proc.stdout.on('data', (d) => {
      if (status.lastError) status.lastError = null;
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= PIXELS) {
        processFrame(pending.subarray(0, PIXELS));
        pending = pending.subarray(PIXELS);
      }
    });
    proc.on('error', (e) => { status.lastError = e.message; });
    proc.on('exit', (code) => {
      proc = null;
      status.running = false;
      if (wanted) {
        const err = errText.trim() || `ffmpeg exited (${code})`;
        if (err !== status.lastError) log(`camera stopped: ${err} — retrying every 5 s`);
        status.lastError = err;
        scheduleRestart();
      }
    });
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { if (wanted) start(); }, 5000);
  }

  function stop() {
    wanted = false;
    clearTimeout(restartTimer);
    if (proc) proc.kill('SIGTERM');
    status.level = 0;
  }

  return {
    start, stop,
    restart() { stop(); setTimeout(start, 500); },
    status: () => ({ ...status }),
    snapshot: () => (latest ? toBmp(latest, getConfig().camera.box) : null),
  };
}

module.exports = { createCamera, listCameras, W, H };
