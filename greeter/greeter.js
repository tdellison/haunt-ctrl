// ─── Greeter brain — who gets greeted, when, and with what ────────────────────
//
// Triggers:
//   camera  — the main sensor. Someone comes through the door → she greets.
//   chime   — the backup. If the chime rings and the camera has not greeted
//             anyone in the last few seconds, wait a beat (the camera may still
//             see them) and then say hello anyway.
//   test    — the setup page's GREET NOW button (ignores pause/hours/cooldown).
//
// Guards: cooldown between greetings (a group walking in = one hello), office
// hours, and a manual "team pause" for when staff are coming and going.
//
// Lines are spoken in Lily's ElevenLabs voice and cached on disk, so a greeting
// starts instantly and each line is only paid for once.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { elevenTts } = require('../lily/talk');

const CACHE_DIR = path.join(__dirname, 'cache');
const RECENT = 3;   // never repeat one of the last N lines

// Through her own speaker when it is connected; otherwise the computer's own
// output (she is right next to it) so a greeting is never silent.
function playLocal(file) {
  return new Promise((resolve) => {
    const p = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file], { stdio: 'ignore' });
    p.on('exit', resolve); p.on('error', resolve);
  });
}

function createGreeter({ lily, log = console.log, getConfig, getElevenKey,
  onGreeted = () => {},             // (line) — opens the conversation window
  inConversation = () => false }) {
  const status = { greeting: false, lastGreet: null, lastLine: null, lastReason: null, pausedUntil: 0, today: 0, todayDate: null, lastError: null };
  const recent = [];
  let lastGreetAt = 0, chimeTimer = null;

  const cacheFile = (voiceId, text) =>
    path.join(CACHE_DIR, `${crypto.createHash('sha1').update(`${voiceId}|${text}`).digest('hex').slice(0, 16)}.mp3`);

  async function voiced(text) {
    const cfg = getConfig();
    const key = getElevenKey();
    if (!key || !cfg.voiceId) return null;
    const file = cacheFile(cfg.voiceId, text);
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, await elevenTts(text, cfg.voiceId, key, 'normal'));
    return file;
  }

  // Voice every line ahead of time so the first greeting of the day is instant.
  async function warm() {
    if (!getElevenKey() || !getConfig().voiceId) return 0;
    let n = 0;
    for (const text of allLines()) {
      try { await voiced(text); n++; } catch (e) { log(`voice for "${text}" not ready: ${e.message}`); }
    }
    if (n) log(`${n} greeting line(s) voiced and cached`);
    return n;
  }

  function allLines() {
    const l = getConfig().lines;
    return [...new Set(Object.values(l).flat().map(s => String(s).trim()).filter(Boolean))];
  }

  function pickLine() {
    const cfg = getConfig();
    const h = new Date().getHours();
    const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    const pool = [...(cfg.lines.any || []), ...(cfg.lines[part] || [])].map(s => String(s).trim()).filter(Boolean);
    if (!pool.length) return null;
    const fresh = pool.filter(l => !recent.includes(l));
    const choices = fresh.length ? fresh : pool;
    const line = choices[Math.floor(Math.random() * choices.length)];
    recent.push(line);
    while (recent.length > RECENT) recent.shift();
    return line;
  }

  function inHours() {
    const { start, end } = getConfig().hours || {};
    if (!start || !end) return true;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const toMin = (s) => { const [a, b] = s.split(':').map(Number); return a * 60 + (b || 0); };
    const s = toMin(start), e = toMin(end);
    const dayOk = !(getConfig().hours.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6));
    return dayOk && (s <= e ? mins >= s && mins < e : mins >= s || mins < e);
  }

  async function greet(reason) {
    const cfg = getConfig();
    const forced = reason === 'test';
    if (!forced) {
      if (Date.now() < status.pausedUntil) return skip('team pause');
      if (!inHours()) return skip('outside greeting hours');
      if (Date.now() - lastGreetAt < cfg.cooldownSec * 1000) return skip('cooldown');
      if (inConversation()) return skip('she is mid-conversation');
    }
    if (status.greeting) return skip('already greeting');
    clearTimeout(chimeTimer);
    status.greeting = true;
    lastGreetAt = Date.now();
    const line = pickLine();
    try {
      const st = lily.status();
      if (st.connected) {
        lily.setMood(cfg.lanternMood || 'calm').catch(e => log(`lantern: ${e.message}`));
        if (st.armed) await lily.move(cfg.movement || 'all').catch(e => log(`movement: ${e.message}`));
      }
      let file = null;
      if (line) {
        try { file = await voiced(line); } catch (e) { log(`ElevenLabs failed: ${e.message}`); }
      }
      if (file && st.audio && st.audio.connected) {
        await lily.playFile(file);
      } else if (file) {
        log('her speaker is not connected — greeting through the computer speaker');
        await playLocal(file);
      } else if (st.connected && cfg.builtinClip) {
        // No voice available: one of her own stored phrases instead.
        await lily.playMedia(cfg.builtinClip);
      } else {
        throw new Error('nothing to say with — add the ElevenLabs key, or connect Lily for her built-in phrases');
      }
      const today = new Date().toDateString();
      if (status.todayDate !== today) { status.todayDate = today; status.today = 0; }
      status.today++;
      Object.assign(status, { lastGreet: new Date().toISOString(), lastLine: file ? line : `built-in clip ${cfg.builtinClip}`, lastReason: reason, lastError: null });
      log(`greeted (${reason}): "${status.lastLine}"`);
      onGreeted(file ? line : null);
    } catch (e) {
      status.lastError = e.message;
      log(`greeting failed: ${e.message}`);
    } finally {
      status.greeting = false;
      lastGreetAt = Date.now();     // cooldown runs from the END of the line
    }
  }

  function skip(why) { log(`not greeting: ${why}`); return null; }

  return {
    greet,
    warm,
    onCamera: () => greet('camera'),
    onChime() {
      const cfg = getConfig();
      if (status.greeting || inConversation()) return;
      if (Date.now() - lastGreetAt < cfg.chimeWindowSec * 1000) return log('chime: camera already greeted them');
      log(`chime heard — waiting ${cfg.chimeDelaySec}s for the camera`);
      clearTimeout(chimeTimer);
      chimeTimer = setTimeout(() => {
        if (Date.now() - lastGreetAt < cfg.chimeWindowSec * 1000) return;
        greet('chime');
      }, cfg.chimeDelaySec * 1000);
    },
    pause(minutes) {
      status.pausedUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0;
      log(minutes > 0 ? `paused for ${minutes} min` : 'resumed');
    },
    status: () => ({ ...status, inHours: inHours() }),
  };
}

module.exports = { createGreeter, playLocal };
