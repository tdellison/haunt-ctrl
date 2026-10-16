// ─── Greeter chime listener — the door chime as the BACKUP trigger ───────────
//
// The mic is read continuously (ffmpeg, PipeWire/Pulse source, 16 kHz mono).
// LEARN: ring the chime once while recording; the loudest moment is run
// through an FFT and its strongest tones are saved. LISTEN: every 64 ms the
// last 128 ms of sound is checked (Goertzel) for exactly those tones. When
// they carry most of the sound's energy it is the chime — talking, footsteps
// and phones spread their energy everywhere and never match.

'use strict';

const { spawn, execFile } = require('child_process');

const RATE = 16000;
const WIN = 2048;           // 128 ms analysis window
const HOP = 1024;           // checked every 64 ms
const LEARN_FFT = 4096;
const FMIN = 250, FMAX = 6000;

const AUDIO_ENV = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
};

function listMics() {
  return new Promise((resolve) => {
    execFile('pw-dump', [], { env: AUDIO_ENV, maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        resolve(JSON.parse(out)
          .filter(o => o.info?.props?.['media.class'] === 'Audio/Source')
          .map(o => ({ name: o.info.props['node.name'], description: o.info.props['node.description'] || o.info.props['node.name'] })));
      } catch (_) { resolve([]); }
    });
  });
}

// Power of one frequency over a block (generalised Goertzel, non-integer bins
// allowed), scaled so a sine of amplitude A reads A²/2 — same scale as the
// block's mean square, so the two can be compared directly.
function tonePower(x, start, n, freq) {
  const coeff = 2 * Math.cos(2 * Math.PI * freq / RATE);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[start + i] + coeff * s1 - s2;
    s2 = s1; s1 = s;
  }
  return 2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

function meanSquare(x, start, n) {
  let e = 0;
  for (let i = 0; i < n; i++) e += x[start + i] * x[start + i];
  return e / n;
}

// Magnitude spectrum (radix-2 FFT, Hann window).
function spectrum(x) {
  const n = x.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

// The chime's strongest tones in a recording: up to 3 spectral peaks from the
// loudest stretch, at least 60 Hz apart.
function learnTones(samples) {
  if (samples.length < LEARN_FFT) throw new Error('Recording too short');
  let best = 0, bestAt = 0;
  for (let i = 0; i + LEARN_FFT <= samples.length; i += HOP) {
    const e = meanSquare(samples, i, LEARN_FFT);
    if (e > best) { best = e; bestAt = i; }
  }
  if (Math.sqrt(best) < 0.01) throw new Error('Heard nothing — is the right mic selected, and did the chime ring?');
  const mag = spectrum(samples.subarray(bestAt, bestAt + LEARN_FFT));
  const hz = (k) => k * RATE / LEARN_FFT;
  const peaks = [];
  for (let k = 2; k < mag.length - 2; k++) {
    if (hz(k) < FMIN || hz(k) > FMAX) continue;
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      // Parabolic interpolation for the true peak frequency between bins.
      const a = mag[k - 1], b = mag[k], c = mag[k + 1];
      const off = 0.5 * (a - c) / (a - 2 * b + c || 1);
      peaks.push({ freq: hz(k + off), mag: b });
    }
  }
  peaks.sort((p, q) => q.mag - p.mag);
  const tones = [];
  for (const p of peaks) {
    if (p.mag < peaks[0].mag * 0.2) break;
    if (tones.every(t => Math.abs(t - p.freq) > 60)) tones.push(Math.round(p.freq));
    if (tones.length === 3) break;
  }
  // How tonal the real chime measured, so the threshold can sit below it.
  let peakRatio = 0;
  for (let i = bestAt; i + WIN <= Math.min(samples.length, bestAt + LEARN_FFT); i += HOP) {
    const ms = meanSquare(samples, i, WIN);
    const r = tones.reduce((s, f) => s + tonePower(samples, i, WIN, f), 0) / (ms || 1);
    peakRatio = Math.max(peakRatio, r);
  }
  return { tones, peakRatio: Math.round(peakRatio * 100) / 100, level: Math.round(Math.sqrt(best) * 1000) / 1000 };
}

// onAudio receives every raw 16 kHz mono s16le block, so the conversation
// listener shares this one mic stream instead of opening its own.
function createChime({ log = console.log, getConfig, saveChime, onChime = () => {}, onAudio = () => {} }) {
  const status = { running: false, source: null, ratio: 0, level: 0, lastChime: null, lastError: null, learning: false };
  let proc = null, wanted = false, restartTimer = null;
  const ring = new Float32Array(RATE * 8);
  let ringLen = 0;   // last 8 s, for LEARN
  const circ = new Float32Array(WIN), win = new Float32Array(WIN);
  let circAt = 0, winFill = 0, sinceHop = 0;
  let carry = Buffer.alloc(0);
  let hits = 0, quietUntil = 0;

  function analyse() {
    const c = getConfig().chime;
    const ms = meanSquare(win, 0, WIN);
    status.level = Math.round(Math.sqrt(ms) * 1000) / 1000;
    if (!c.enabled || !c.tones || !c.tones.length) { status.ratio = 0; return; }
    const ratio = c.tones.reduce((s, f) => s + tonePower(win, 0, WIN, f), 0) / (ms || 1);
    status.ratio = Math.round(ratio * 100) / 100;
    if (ratio >= c.threshold && status.level >= c.minLevel) hits++;
    else hits = 0;
    if (hits >= 2 && Date.now() >= quietUntil) {
      hits = 0;
      quietUntil = Date.now() + 5000;     // one ding-dong = one trigger
      status.lastChime = new Date().toISOString();
      onChime();
    }
  }

  function onSamples(f32) {
    // Learning buffer: shift the whole block in at once.
    if (f32.length >= ring.length) ring.set(f32.subarray(f32.length - ring.length));
    else { ring.copyWithin(0, f32.length); ring.set(f32, ring.length - f32.length); }
    ringLen = Math.min(ring.length, ringLen + f32.length);
    for (let i = 0; i < f32.length; i++) {
      circ[circAt] = f32[i];
      circAt = (circAt + 1) % WIN;
      if (winFill < WIN) winFill++;
      if (winFill === WIN && ++sinceHop >= HOP) {
        sinceHop = 0;
        win.set(circ.subarray(circAt), 0);           // unroll oldest-first
        win.set(circ.subarray(0, circAt), WIN - circAt);
        analyse();
      }
    }
  }

  function start() {
    wanted = true;
    if (proc) return;
    const c = getConfig().chime;
    const src = c.source || 'default';
    const input = src.startsWith('lavfi:') ? ['-re', '-f', 'lavfi', '-i', src.slice(6)] : ['-f', 'pulse', '-i', src];
    proc = spawn('ffmpeg', ['-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'],
      { env: AUDIO_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    status.running = true; status.source = src;
    if (!status.lastError) log(`mic: listening on ${src}`);
    let errText = '';
    proc.stderr.on('data', d => { errText = (errText + d).slice(-300); });
    proc.stdout.on('data', (d) => {
      if (status.lastError) { status.lastError = null; log(`mic: listening on ${src}`); }
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const n = buf.length >> 1;
      carry = buf.subarray(n * 2);
      try { onAudio(buf.subarray(0, n * 2)); } catch (e) { log(`mic tap: ${e.message}`); }
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
      onSamples(f);
    });
    proc.on('error', (e) => { status.lastError = e.message; });
    proc.on('exit', (code) => {
      proc = null; status.running = false;
      if (wanted) {
        const err = errText.trim() || `ffmpeg exited (${code})`;
        if (err !== status.lastError) log(`mic stopped: ${err} — retrying every 5 s`);
        status.lastError = err;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (wanted) start(); }, 5000);
      }
    });
  }

  function stop() {
    wanted = false;
    clearTimeout(restartTimer);
    if (proc) proc.kill('SIGTERM');
  }

  // Record `seconds` from now (the chime is rung during it), then learn it.
  async function learn(seconds = 5) {
    if (!proc) start();
    status.learning = true;
    ringLen = 0;
    try {
      await new Promise(r => setTimeout(r, seconds * 1000));
      const take = Math.min(ringLen, Math.round(seconds * RATE));
      const res = learnTones(ring.slice(ring.length - take));
      const threshold = Math.max(0.2, Math.min(0.5, res.peakRatio * 0.6));
      saveChime({ tones: res.tones, threshold, minLevel: Math.max(0.005, res.level * 0.15) });
      log(`chime learned: ${res.tones.join(' / ')} Hz (tonal ${res.peakRatio}, threshold ${threshold.toFixed(2)})`);
      return { ...res, threshold };
    } finally { status.learning = false; }
  }

  return {
    start, stop, learn,
    restart() { stop(); setTimeout(start, 500); },
    status: () => ({ ...status, tones: getConfig().chime.tones || [] }),
  };
}

module.exports = { createChime, listMics, learnTones, tonePower, meanSquare, RATE, WIN };
