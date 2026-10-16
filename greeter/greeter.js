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
// Team recognition (optional, faces.js): after the camera fires she looks at
// the next couple of seconds of frames before speaking —
//   a face she doesn't know  -> visitor greeting (even if a teammate is with them)
//   only teammates           -> a short remark by name ("Oh, it's just you,
//                               Todd. You may go now."), at most once per person
//                               per hour; otherwise she stays quiet
//   no face at all           -> someone walking OUT (backs to her): quiet
// Any camera event also tells the chime listener the door is already handled,
// so the chime never greets someone the camera has just seen leaving.
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
  inConversation = () => false,
  faces = null,                     // faces.js, or null
  outfit = null,                    // outfit.js, or null
  nextFrame = async () => null }) { // the camera's next JPEG
  const status = { greeting: false, lastGreet: null, lastLine: null, lastReason: null, pausedUntil: 0, today: 0, todayDate: null,
    lastError: null, lastSeen: null };
  const recent = [], recentTeam = [];
  const teamSaidAt = {};            // name -> last remark time
  let lastGreetAt = 0, lastCameraAt = 0, chimeTimer = null, looking = false;

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
    const cfg = getConfig();
    const names = faces && cfg.faces.enabled ? faces.teamNames() : [];
    const team = names.flatMap(n => (cfg.teamLines || []).map(l => l.replace(/\{name\}/g, n)));
    return [...new Set([...Object.values(cfg.lines).flat(), ...team].map(s => String(s).trim()).filter(Boolean))];
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

  function blockedBy(cfg) {
    if (Date.now() < status.pausedUntil) return 'team pause';
    if (!inHours()) return 'outside greeting hours';
    if (Date.now() - lastGreetAt < cfg.cooldownSec * 1000) return 'cooldown';
    if (inConversation()) return 'she is mid-conversation';
    return null;
  }

  // Look at the next few frames: who is at the door?
  // -> { kind: 'visitor' | 'team' | 'nobody', names }
  async function look() {
    const f = getConfig().faces;
    const until = Date.now() + f.lookSec * 1000;
    const names = new Set();
    let strangers = 0, teamFrames = 0, frame = null;
    while (Date.now() < until) {
      const jpeg = await nextFrame(1000);
      if (!jpeg) continue;
      let seen;
      try { seen = await faces.identify(jpeg, { minFace: f.minFacePx, threshold: f.threshold }); }
      catch (e) { log(`faces: ${e.message} — greeting as a visitor`); return { kind: 'visitor', names: [] }; }
      if (!seen.length) continue;
      status.lastSeen = seen.map(x => x.name ? `${x.name} (${x.score})` : `unknown (closest ${x.closest || '-'} ${x.score})`).join(', ');
      if (seen.some(x => !x.name)) { frame = jpeg; if (++strangers >= 2) break; }
      else { seen.forEach(x => names.add(x.name)); if (++teamFrames >= 2) break; }
    }
    if (strangers) return { kind: 'visitor', names: [...names], frame };
    if (names.size) return { kind: 'team', names: [...names] };
    return { kind: 'nobody', names: [] };
  }

  async function onCamera() {
    const cfg = getConfig();
    lastCameraAt = Date.now();
    const why = blockedBy(cfg);
    if (why) return skip(why);
    const useFaces = faces && cfg.faces.enabled && faces.status().ready;
    if (!useFaces) return greet('camera');
    if (looking || status.greeting) return;
    looking = true;
    let who;
    try { who = await look(); } finally { looking = false; }
    lastCameraAt = Date.now();
    if (who.kind === 'visitor') return greet('camera', who.frame);
    if (who.kind === 'team') return teamRemark(who.names);
    if (cfg.faces.requireFace) return log('camera: no face seen (someone leaving?) — staying quiet');
    return greet('camera');
  }

  // A teammate: a short remark by name, at most once per person per interval.
  async function teamRemark(names) {
    const cfg = getConfig();
    const due = names.filter(n => Date.now() - (teamSaidAt[n] || 0) >= cfg.faces.teamRemarkEveryMin * 60000);
    if (!due.length || !(cfg.teamLines || []).length) return log(`camera: ${names.join(' & ')} — team, staying quiet`);
    const name = due.length > 1 ? `${due.slice(0, -1).join(', ')} and ${due[due.length - 1]}` : due[0];
    const pool = cfg.teamLines.filter(l => !recentTeam.includes(l));
    const tpl = (pool.length ? pool : cfg.teamLines)[Math.floor(Math.random() * (pool.length || cfg.teamLines.length))];
    recentTeam.push(tpl); while (recentTeam.length > 2) recentTeam.shift();
    due.forEach(n => { teamSaidAt[n] = Date.now(); });
    await speak(tpl.replace(/\{name\}/g, name), 'team', { openMic: false, countIt: false });
  }

  async function greet(reason, frame = null) {
    const cfg = getConfig();
    if (reason !== 'test') {
      const why = blockedBy(cfg);
      if (why) return skip(why);
    }
    // Outfit remark: written by Claude from a camera picture WHILE the
    // greeting plays; said after it, or dropped if it isn't ready in time.
    let remark = null;
    if (outfit && cfg.outfit.enabled && reason !== 'chime' && (reason === 'test' || Math.random() < cfg.outfit.chance)) {
      remark = (async () => {
        const jpeg = frame || await nextFrame(1000);
        return jpeg ? outfit.remark(jpeg) : null;
      })().catch((e) => { log(`outfit remark failed: ${e.message}`); return null; });
    }
    const line = pickLine();
    const ok = await speak(line, reason, { openMic: !remark, countIt: true });
    if (!remark) return;
    const extra = await Promise.race([remark, new Promise(r => setTimeout(() => r(null), 4000))]);
    if (ok && extra) await speak(extra, 'outfit', { openMic: true, countIt: false });
    else if (ok) onGreeted(line);
  }

  async function speak(line, reason, { openMic, countIt }) {
    const cfg = getConfig();
    if (status.greeting) return skip('already greeting');
    clearTimeout(chimeTimer);
    status.greeting = true;
    if (countIt) lastGreetAt = Date.now();
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
      } else if (st.connected && cfg.builtinClip && reason !== 'team') {
        // No voice available: one of her own stored phrases instead.
        await lily.playMedia(cfg.builtinClip);
      } else {
        throw new Error('nothing to say with — add the ElevenLabs key, or connect Lily for her built-in phrases');
      }
      if (countIt) {
        const today = new Date().toDateString();
        if (status.todayDate !== today) { status.todayDate = today; status.today = 0; }
        status.today++;
      }
      Object.assign(status, { lastGreet: new Date().toISOString(), lastLine: file ? line : `built-in clip ${cfg.builtinClip}`, lastReason: reason, lastError: null });
      log(`${reason === 'team' ? 'said' : 'greeted'} (${reason}): "${status.lastLine}"`);
      if (openMic) onGreeted(file ? line : null);
      return true;
    } catch (e) {
      status.lastError = e.message;
      log(`greeting failed: ${e.message}`);
    } finally {
      status.greeting = false;
      if (countIt) lastGreetAt = Date.now();     // cooldown runs from the END of the line
    }
  }

  function skip(why) { log(`not greeting: ${why}`); return null; }

  return {
    greet,
    warm,
    onCamera: () => onCamera().catch(e => log(`camera trigger failed: ${e.message}`)),
    // Backup only: the camera saw nothing at the door around this chime.
    onChime() {
      const cfg = getConfig();
      const cameraHandled = () => looking || Date.now() - Math.max(lastCameraAt, lastGreetAt) < cfg.chimeWindowSec * 1000;
      if (status.greeting || inConversation()) return;
      if (cameraHandled()) return log('chime: the camera already saw them');
      log(`chime heard — waiting ${cfg.chimeDelaySec}s for the camera`);
      clearTimeout(chimeTimer);
      chimeTimer = setTimeout(() => {
        if (cameraHandled()) return;
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
