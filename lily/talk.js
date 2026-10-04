// ─── Lily talk — hear a guest, answer with one of HER OWN built-in clips ──────
//
// Two voice modes (switchable, persisted in lily-talk.json):
//
//   'voice' (default) — Claude WRITES her line, ElevenLabs speaks it in her
//     designed voice (voices.json "lily"), played through HER speaker over
//     Classic BT; falls back to the witch zone (z3) when her speaker isn't
//     connected, so a test is never silent.
//   'clips' — she answers only with the sound files stored on the prop,
//     played over BLE (playMedia); Claude picks the clip from the catalog
//     (lily/clips.json), built by buildCatalog(): play each serial, record her
//     speaker, transcribe. She can never "say" a line she doesn't have.
//
//   mic (ffmpeg, pulse) -> energy VAD -> WAV -> whisper.cpp -> text
//   -> Claude { line | clip, lantern mood, movement } -> lantern + movement + speech
//
// Nothing here throws into a show beat; every failure lands in status.lastError
// and the log. Movement still obeys the interlock — if her motors are not
// armed, she answers with voice + lantern only.

'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIPS_FILE = path.join(__dirname, 'clips.json');
const WHISPER_BIN = path.join(os.homedir(), 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL = path.join(os.homedir(), 'whisper.cpp', 'models', 'ggml-base.en.bin');
const MODEL = 'claude-opus-5';

const RATE = 16000;
const FRAME = 320;                 // 20 ms of 16 kHz mono
const START_FRAMES = 3;            // 60 ms above threshold starts an utterance
const END_SILENCE_MS = 800;        // this much quiet ends it
const MIN_UTTER_MS = 400;
const MAX_UTTER_MS = 12000;
const PREROLL_FRAMES = 15;         // keep 300 ms before the trigger
const DEFAULT_CLIP_MS = 4000;      // hold time when a clip's length is unknown
const HISTORY_TURNS = 8;
const SETTINGS_FILE = path.join(__dirname, '..', 'lily-talk.json');   // per machine, gitignored
const TTS_MODEL = process.env.LILY_TTS_MODEL || 'eleven_flash_v2_5';   // lowest-latency ElevenLabs model
const MAX_LINE_WORDS = 30;

const AUDIO_ENV = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`,
};

function wavBuffer(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function rms(buf) {
  let s = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / Math.max(1, n));
}

function transcribe(pcm) {
  const file = path.join(os.tmpdir(), `lily-heard-${Date.now()}.wav`);
  fs.writeFileSync(file, wavBuffer(pcm));
  return new Promise((resolve) => {
    execFile(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', file, '-nt', '-np', '-t', String(Math.max(2, os.cpus().length))],
      { timeout: 30000 }, (err, out) => {
        try { fs.unlinkSync(file); } catch (_) {}
        if (err) return resolve('');
        // whisper marks non-speech as [BLANK_AUDIO], (wind), etc.
        resolve(out.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
      });
  });
}

function listSources() {
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

// Lily's character for choosing replies. She has no words of her own here —
// only her stored clips — so this steers WHICH clip, lantern and gesture.
function systemPrompt(clips, guardrail) {
  const catalog = clips.map(c => `${c.serial}: "${c.text}"`).join('\n');
  return [
    'You are the mind of Lethal Lily, a lantern-bearing witch animatronic at Thornfield Cemetery (est. 1724) ' +
    'on Halloween night. She is a watchful, protective presence beside the witches Evelina and Lenora: ' +
    'eerie, dry, a little amused by mortals, never cruel to children.',
    'Lily can ONLY speak using her built-in recorded clips, listed below by number. When a guest says something, ' +
    'pick the ONE clip whose words fit best as her reply. If nothing fits, pick the closest in spirit; pick 0 only ' +
    'if the input is empty noise or clearly not addressed to her.',
    'Also pick her lantern mood: calm (friendly, settled), wary (uneasy, suspicious, teasing threat), ward ' +
    '(protective flare — only when someone is threatened, rude, or something goes wrong), or keep (no change). ' +
    'And a movement for while she speaks: none, head, eyes, wrist, arm, arm_and_wrist, head_and_eyes, head_and_arm, all. ' +
    'Prefer head or head_and_eyes for ordinary replies; save arm and all for big moments.',
    guardrail || '',
    'HER CLIPS:\n' + (catalog || '(none catalogued yet)'),
  ].filter(Boolean).join('\n\n');
}

// Voice mode: Lily writes her own words, so this carries her character, her
// friction with Evelina, and the length/format rules for speech.
function voicePrompt(guardrail) {
  return [
    'You are Lethal Lily, a lantern-bearing witch at Thornfield Cemetery (est. 1724) on Halloween night, during ' +
    'the Hollow Storm. You stand with the witches Evelina Crowe (charming, curious, overconfident — she keeps ' +
    'trying to complete a dangerous ritual) and Lenora Thorn (wise, dry). Two skeletons, Jasper and Edgar, ' +
    'watch from behind you.',
    'Character: watchful and protective, eerie and dry, a little amused by mortals, never cruel to children. ' +
    'Your lantern is your mood. You guard Evelina from her own recklessness and are not shy about scolding her — ' +
    'when she pushes too far you push back ("Enough. Do it again, and do it right this time."). You bicker with ' +
    'her, but you are on her side.',
    `You are SPEAKING OUT LOUD to guests. Reply with ONE short spoken line, under ${MAX_LINE_WORDS} words: no ` +
    'stage directions, no asterisks, no emoji, no quotation marks around the whole line. Keep it natural and ' +
    'in the moment; talk WITH the guest, answer what they said. Kids get warmth under the eeriness.',
    'Also pick your lantern mood: calm (friendly, settled), wary (uneasy, suspicious, teasing threat), ward ' +
    '(protective flare — only when someone is threatened, rude, or something goes wrong), or keep (no change). ' +
    'And a movement while you speak (your mouth always moves with your words): none, head (turns and tilts), ' +
    'eyes, wrist (your free left hand twists), arm (your free left arm lifts — your lantern arm stays still), ' +
    'arm_and_wrist (a full beckoning gesture), head_and_eyes, head_and_arm, all. Prefer head or head_and_eyes ' +
    'for ordinary replies, wrist or arm_and_wrist to beckon, and save all for big moments.',
    'And a tone of voice: normal (most lines), sweet (warmth, especially for small children), excited (delight, good news), shout (raising your voice — calling across the yard, or silencing someone), angry (scolding ' +
    'Evelina, or someone being rude), whisper (secrets, menace up close), ominous (warnings about the storm). ' +
    'Use the strong tones sparingly so they land.',
    guardrail || '',
  ].filter(Boolean).join('\n\n');
}

// Delivery tones. 'normal' stays on the fast model; the expressive tones use
// Eleven v3, which reads a leading audio tag ([sweetly], [angrily]) as a
// performance cue (v3 stability: 0 creative / 0.5 natural / 1 robust).
const TONES = {
  normal:   { model: TTS_MODEL },
  sweet:    { model: 'eleven_v3', tag: '[sweetly]', stability: 0.5 },
  angry:    { model: 'eleven_v3', tag: '[angrily]', stability: 0.0 },
  whisper:  { model: 'eleven_v3', tag: '[whispers]', stability: 0.5 },
  excited:  { model: 'eleven_v3', tag: '[excitedly]', stability: 0.0 },
  shout:    { model: 'eleven_v3', tag: '[shouting]', stability: 0.0 },
  ominous:  { model: 'eleven_v3', tag: '[ominously]', stability: 0.5 },
};

// ElevenLabs text-to-speech -> mp3 bytes.
async function elevenTts(text, voiceId, apiKey, tone = 'normal') {
  const t = TONES[tone] || TONES.normal;
  const body = { text: t.tag ? `${t.tag} ${text}` : text, model_id: t.model };
  if (t.stability !== undefined) body.voice_settings = { stability: t.stability };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = '';
    try { const b = await r.json(); detail = b.detail?.message || b.detail?.status || JSON.stringify(b.detail || b); } catch (_) {}
    throw new Error(`ElevenLabs ${r.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function createTalk({ lily, log = console.log, logDialogue = () => {}, micsMuted = () => false,
  getApiKey = () => process.env.ANTHROPIC_API_KEY, trackTokens = () => {}, guardrail = '', onChange = () => {},
  getElevenKey = () => process.env.ELEVENLABS_API_KEY, getVoiceId = () => null,
  playFallback = null }) {   // (file) => Promise — plays in the witch zone when her speaker is not connected
  let settings = { mode: 'voice' };
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
  const saveSettings = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (_) {} };
  let clips = [];
  try { clips = JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8')); } catch (_) {}
  const saveClips = () => {
    try { fs.writeFileSync(CLIPS_FILE, JSON.stringify(clips, null, 2)); } catch (e) { log(`clip catalog save failed: ${e.message}`); }
  };

  const status = {
    listening: false, source: null, phase: 'idle', lastHeard: null, lastReply: null,
    lastError: null, cataloging: null,
  };
  const history = [];
  let capture = null;
  let busyUntil = 0;       // ignore the mic while she is speaking (+ tail)
  let busy = false;

  const set = (patch) => { Object.assign(status, patch); onChange(); };

  let client = null;
  function anthropic() {
    const key = getApiKey();
    if (!key) throw new Error('No Anthropic API key — add it in Setup → API Keys');
    if (!client || client._hauntKey !== key) {
      const A = require('@anthropic-ai/sdk');
      client = new (A.default || A)({ apiKey: key, timeout: 20000, maxRetries: 1 });
      client._hauntKey = key;
    }
    return client;
  }

  const MOVES = Object.keys(require('./protocol').MOVEMENT);
  const voiceSchema = {
    type: 'object',
    properties: {
      line: { type: 'string' },
      tone: { type: 'string', enum: Object.keys(TONES) },
      lantern: { type: 'string', enum: ['calm', 'wary', 'ward', 'keep'] },
      move: { type: 'string', enum: MOVES },
    },
    required: ['line', 'tone', 'lantern', 'move'],
    additionalProperties: false,
  };
  const schema = () => settings.mode === 'voice' ? voiceSchema : ({
    type: 'object',
    properties: {
      clip: { type: 'integer', enum: [0, ...clips.map(c => c.serial)] },
      lantern: { type: 'string', enum: ['calm', 'wary', 'ward', 'keep'] },
      move: { type: 'string', enum: MOVES },
    },
    required: ['clip', 'lantern', 'move'],
    additionalProperties: false,
  });

  async function decide(heard) {
    const c = anthropic();
    const messages = [...history, { role: 'user', content: `Guest says: "${heard}"` }];
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: schema() } },
      system: [{ type: 'text', text: settings.mode === 'voice' ? voicePrompt(guardrail) : systemPrompt(clips, guardrail),
        cache_control: { type: 'ephemeral' } }],
      messages,
    });
    trackTokens(response.model || MODEL, response.usage?.input_tokens, response.usage?.output_tokens);
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer that one');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const choice = JSON.parse(text);
    history.push({ role: 'user', content: `Guest says: "${heard}"` }, { role: 'assistant', content: text });
    while (history.length > HISTORY_TURNS * 2) history.splice(0, 2);
    return choice;
  }

  // Voice mode: speak `text` in her ElevenLabs voice through her own speaker
  // (or the witch zone when her speaker isn't connected), moving while she talks.
  async function speakLine(text, { lantern, move, tone } = {}) {
    const key = getElevenKey();
    const voiceId = getVoiceId();
    if (!key) throw new Error('No ElevenLabs key — add it in Setup → API Keys');
    if (!voiceId) throw new Error('No voice ID for "lily" in voices.json');
    const st = lily.status();
    const audio = await elevenTts(text, voiceId, key, tone);
    const file = path.join(os.tmpdir(), `lily-say-${Date.now()}.mp3`);
    fs.writeFileSync(file, audio);
    if (lantern && lantern !== 'keep' && st.connected) await lily.setMood(lantern).catch(e => log(`lantern: ${e.message}`));
    let moved = false;
    if (move && move !== 'none' && st.connected && st.armed) {
      moved = await lily.move(move).then(() => true).catch(e => { log(`move: ${e.message}`); return false; });
    }
    const where = st.audio && st.audio.routed ? 'her speaker' : 'witch zone';
    set({ phase: 'speaking' });
    busyUntil = Date.now() + 60000;             // deaf until playback ends (+ tail below)
    try {
      if (where === 'her speaker') await lily.playFile(file);
      else if (playFallback) await playFallback(file);
      else throw new Error('Lily speaker not connected and no fallback output');
    } finally {
      busyUntil = Date.now() + 700;
      try { fs.unlinkSync(file); } catch (_) {}
      if (moved) await lily.move('none').catch(() => {});
    }
    return where;
  }

  // Act out a choice: lantern, then movement for the clip's length, then clip.
  async function perform(choice, heard) {
    if (settings.mode === 'voice') {
      const line = String(choice.line || '').replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
      if (!line) { set({ lastReply: { heard, text: '(stayed silent)' } }); return; }
      set({ lastReply: { heard, text: line, lantern: choice.lantern, move: choice.move } });
      logDialogue({ character: 'lily', line, trigger: 'guest_mic', context: heard, engine: 'claude',
        extra: { mode: 'voice', lantern: choice.lantern, move: choice.move } });
      const where = await speakLine(line, choice);
      set({ lastReply: { ...status.lastReply, where } });
      return;
    }
    const clip = clips.find(c => c.serial === choice.clip);
    if (!clip) { set({ lastReply: { heard, clip: 0, text: '(stayed silent)' } }); return; }
    const st = lily.status();
    if (choice.lantern && choice.lantern !== 'keep') await lily.setMood(choice.lantern).catch(e => log(`lantern: ${e.message}`));
    const holdMs = clip.durationMs || DEFAULT_CLIP_MS;
    busyUntil = Date.now() + holdMs + 700;
    let moved = false;
    if (choice.move && choice.move !== 'none' && st.armed) {
      moved = await lily.move(choice.move).then(() => true).catch(e => { log(`move: ${e.message}`); return false; });
    }
    await lily.playMedia(clip.serial);
    logDialogue({ character: 'lily', line: clip.text, trigger: 'guest_mic', context: heard,
      engine: 'claude', extra: { mode: 'clips', clip: clip.serial, lantern: choice.lantern, move: choice.move } });
    set({ phase: 'speaking', lastReply: { heard, clip: clip.serial, text: clip.text, lantern: choice.lantern, move: choice.move } });
    await new Promise(r => setTimeout(r, holdMs));
    if (moved) await lily.move('none').catch(() => {});
  }

  // One full turn from text. Used by the mic loop and by the "type instead" box.
  async function respond(heard) {
    if (busy) throw new Error('Lily is still answering');
    busy = true;
    try {
      set({ phase: 'thinking', lastHeard: heard, lastError: null });
      if (settings.mode === 'clips') {
        if (!clips.length) throw new Error('No clips catalogued yet — run BUILD CATALOG first');
        if (!lily.status().connected) throw new Error('Lily is not connected');
      }
      const choice = await decide(heard);
      log(`heard "${heard}" -> ${settings.mode === 'voice' ? `"${choice.line}"` : `clip ${choice.clip}`}, ${choice.lantern}, ${choice.move}`);
      await perform(choice, heard);
      return status.lastReply;
    } catch (e) {
      set({ lastError: e.message });
      throw e;
    } finally {
      busy = false;
      set({ phase: status.listening ? 'listening' : 'idle' });
    }
  }

  // Mic capture with a simple energy VAD. The noise floor is learned from the
  // first second, so the threshold adapts to the room.
  function startCapture(source, onUtterance) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', source || 'default',
      '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
    const proc = spawn('ffmpeg', args, { env: AUDIO_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    let noise = null; const calib = [];
    let loud = 0, quietMs = 0, speaking = false, utter = [], preroll = [];
    proc.stderr.on('data', d => log(`mic: ${d.toString().trim().slice(0, 160)}`));
    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= FRAME * 2) {
        const frame = buf.subarray(0, FRAME * 2); buf = buf.subarray(FRAME * 2);
        const level = rms(frame);
        if (noise === null) {
          calib.push(level);
          if (calib.length >= 50) noise = Math.max(60, calib.sort((a, b) => a - b)[25]);
          continue;
        }
        const threshold = Math.max(noise * 3.5, 300);
        const deaf = Date.now() < busyUntil || busy || micsMuted();
        if (!speaking) {
          preroll.push(Buffer.from(frame)); if (preroll.length > PREROLL_FRAMES) preroll.shift();
          if (!deaf && level > threshold) { if (++loud >= START_FRAMES) { speaking = true; utter = [...preroll]; quietMs = 0; } }
          else { loud = 0; noise = noise * 0.995 + level * 0.005; }
          continue;
        }
        utter.push(Buffer.from(frame));
        quietMs = level > threshold ? 0 : quietMs + 20;
        const lenMs = utter.length * 20;
        if (quietMs >= END_SILENCE_MS || lenMs >= MAX_UTTER_MS) {
          speaking = false; loud = 0;
          const pcm = Buffer.concat(utter); utter = [];
          if (lenMs - quietMs >= MIN_UTTER_MS) onUtterance(pcm);
        }
      }
    });
    return proc;
  }

  async function onUtterance(pcm) {
    if (busy) return;
    set({ phase: 'transcribing' });
    const heard = await transcribe(pcm);
    // whisper "hears" these in plain room noise — never answer them.
    if (!heard || heard.length < 2 || /^(you|thank you|thanks for watching)[.!]?$/i.test(heard)) {
      set({ phase: 'listening' }); return;
    }
    respond(heard).catch(e => log(`turn failed: ${e.message}`));
  }

  // Record what comes out of her speaker for one clip. The recorder starts
  // before playback, so the first 200 ms give the room's noise floor; it then
  // waits up to 4 s for sound and stops 1.5 s after the sound ends.
  // Returns { pcm, durationMs } or null when the serial played nothing.
  function recordClip(source, maxMs = 20000) {
    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', source || 'default',
        '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { env: AUDIO_ENV });
      let buf = Buffer.alloc(0), floor = null, frames = 0, quiet = 0;
      const calib = [], kept = [];
      let firstLoud = -1, lastLoud = -1, done = false;
      const finish = (result) => { if (done) return; done = true; try { proc.kill(); } catch (_) {} resolve(result); };
      proc.on('close', () => finish(null));
      proc.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (!done && buf.length >= FRAME * 2) {
          const frame = buf.subarray(0, FRAME * 2); buf = buf.subarray(FRAME * 2);
          const level = rms(frame); frames++;
          if (floor === null) { calib.push(level); if (calib.length >= 10) floor = Math.max(60, Math.max(...calib)); continue; }
          kept.push(Buffer.from(frame));
          const idx = kept.length - 1;
          if (level > floor * 4) { if (firstLoud < 0) firstLoud = idx; lastLoud = idx; quiet = 0; }
          else if (firstLoud >= 0) quiet += 20;
          if (firstLoud < 0 && frames * 20 > 4000) return finish(null);
          if ((firstLoud >= 0 && quiet >= 1500) || frames * 20 >= maxMs) {
            if (firstLoud < 0 || lastLoud - firstLoud < 10) return finish(null);
            return finish({ pcm: Buffer.concat(kept.slice(firstLoud, lastLoud + 1)), durationMs: (lastLoud - firstLoud + 1) * 20 });
          }
        }
      });
    });
  }

  const api = {
    status: () => ({
      ...status, mode: settings.mode, clips: clips.length, model: MODEL, hasKey: !!getApiKey(),
      hasVoiceKey: !!getElevenKey(), voiceId: getVoiceId() || null,
    }),
    setMode(mode) {
      if (!['voice', 'clips'].includes(mode)) throw new Error('mode must be voice or clips');
      settings.mode = mode; saveSettings();
      history.length = 0;                      // the other mode's replies would confuse the next turn
      set({});
      return api.status();
    },
    // Voice test with no Claude call: say exactly this text in her voice.
    tones: Object.keys(TONES),
    async speak(text, tone = 'normal') {
      if (busy) throw new Error('Lily is still answering');
      busy = true;
      try {
        const line = String(text || '').trim().slice(0, 400);
        if (!line) throw new Error('text required');
        set({ lastError: null, lastReply: { heard: '(typed)', text: line } });
        const where = await speakLine(line, { tone });
        set({ lastReply: { heard: '(typed)', text: line, where } });
        return api.status();
      } catch (e) { set({ lastError: e.message }); throw e; }
      finally { busy = false; set({ phase: status.listening ? 'listening' : 'idle' }); }
    },
    clips: () => clips,
    listSources,

    async start(source) {
      if (status.listening) return api.status();
      if (process.platform !== 'linux') throw new Error('The mic loop runs on the Linux server only');
      capture = startCapture(source, onUtterance);
      capture.on('exit', (code) => {
        if (status.listening) { set({ listening: false, phase: 'idle', lastError: `mic stopped (ffmpeg exit ${code})` }); }
        capture = null;
      });
      set({ listening: true, source: source || 'default', phase: 'listening', lastError: null });
      log(`listening on ${source || 'default mic'}`);
      return api.status();
    },
    stop() {
      if (capture) { const p = capture; capture = null; status.listening = false; try { p.kill(); } catch (_) {} }
      set({ listening: false, phase: 'idle' });
      return api.status();
    },
    say: (text) => respond(String(text || '').slice(0, 300)),
    resetConversation() { history.length = 0; return api.status(); },

    // Walk her stored clips from `from` up, recording + transcribing each.
    // Stops after `to`, or after 3 silent serials in a row (end of her list).
    async buildCatalog({ from = 1, to = 60, source } = {}) {
      if (status.cataloging) throw new Error('Catalog already running');
      if (!lily.status().connected) throw new Error('Lily is not connected');
      if (status.listening) api.stop();
      set({ cataloging: { at: from, found: 0 } });
      let silent = 0, found = 0;
      try {
        for (let serial = from; serial <= to && silent < 3; serial++) {
          set({ cataloging: { at: serial, found } });
          const rec = recordClip(source);
          await new Promise(r => setTimeout(r, 400));   // recorder opens + learns the room first
          await lily.playMedia(serial);
          const got = await rec;
          if (!got) { silent++; log(`clip ${serial}: silent`); continue; }
          silent = 0;
          const text = (await transcribe(got.pcm)) || '(no words — sound effect)';
          clips = clips.filter(c => c.serial !== serial).concat({ serial, text, durationMs: got.durationMs });
          clips.sort((a, b) => a.serial - b.serial);
          saveClips();
          found++;
          log(`clip ${serial}: "${text}" (${(got.durationMs / 1000).toFixed(1)}s)`);
        }
      } finally {
        set({ cataloging: null });
      }
      return { found, clips };
    },
    setClipText(serial, text) {
      const c = clips.find(x => x.serial === serial);
      if (!c) throw new Error(`No clip ${serial}`);
      c.text = String(text).slice(0, 300);
      saveClips();
      return c;
    },
  };
  return api;
}

module.exports = { createTalk };
