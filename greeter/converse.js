// ─── Greeter conversation — visitors can talk to her ─────────────────────────
//
// After she greets someone the mic opens for a short window. If they answer,
// she answers back:
//
//   mic (shared with the chime listener) -> energy VAD -> whisper.cpp -> text
//   -> Claude (Haiku, her work-greeter persona + the office notes from the setup
//      page) -> { line, tone, lantern, move, done } -> ElevenLabs -> her speaker
//
// Every reply re-opens the window, so a back-and-forth keeps going; silence
// closes it. Outside a window she ignores the room — staff chatting across the
// office never gets an answer. "Always listening" on the setup page turns the
// window off for testing.
//
// She is deaf while she speaks (and for a moment after) so she never answers
// her own voice.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { transcribe, ensureWhisperServer, rms, elevenTts, TONES } = require('../lily/talk');
const { MOVEMENT } = require('../lily/protocol');

const MODEL = 'claude-haiku-4-5';   // speed over polish, same call as the haunt's Lily
const RATE = 16000;
const FRAME = 320;                  // 20 ms
const START_FRAMES = 3;
const END_SILENCE_MS = 750;
const MIN_UTTER_MS = 400;
const MAX_UTTER_MS = 12000;
const PREROLL_FRAMES = 15;
const TAIL_MS = 600;                // stay deaf this long after she finishes
const HISTORY_TURNS = 6;
const MAX_WORDS = 35;

function persona(about) {
  return [
    'You are Lily (Lethal Lily), a life-size animatronic skeleton holding a lantern, working as the front-door ' +
    'greeter at an office. You are a Halloween decoration and you know it, and you enjoy the job. Visitors walk in, ' +
    'you have just greeted them, and now they may talk to you.',
    'Character: warm, welcoming and helpful first; a dry, gently spooky wit second (skeleton and afterlife jokes ' +
    'are fine, never gory or frightening). Sweet with children. Professional enough for a workplace: no flirting, ' +
    'no politics, no swearing, nothing mean about anyone.',
    'What you can do: welcome people, chat briefly, and pass on the information in the OFFICE NOTES below. What you ' +
    'cannot do: you cannot see who someone is, call or message anyone, open doors, look anything up, or make ' +
    'promises for the company. If someone needs a person, tell them someone will be with them shortly (or follow ' +
    'the notes). Never invent names, prices, hours, policies or facts that are not in the notes — say you are just ' +
    'the greeter and a team member can help.',
    `You are SPEAKING OUT LOUD: ONE short spoken line, under ${MAX_WORDS} words. No stage directions, asterisks, ` +
    'emoji or quotes. If what you heard is clearly not meant for you (staff talking to each other, a phone call, ' +
    'background noise), reply with an empty line.',
    'Set done = true when the exchange has naturally finished (they said thanks/bye, or walked off), so you stop ' +
    'listening. Lantern: calm (normal), wary (puzzled or playfully suspicious), ward (a bright flare, for a big ' +
    'reaction) or keep. Movement while you talk (your mouth always moves): head_and_eyes for most lines, ' +
    'arm_and_wrist to beckon or wave, all for a big welcome, none to stay still. Tone: normal for most lines, ' +
    'sweet for children, excited for good news, whisper for a playful secret.',
    about ? `OFFICE NOTES (from the staff — trust these):\n${about}` : 'OFFICE NOTES: none given yet.',
  ].join('\n\n');
}

function createConverse({ lily, log = console.log, getConfig, getApiKey, getElevenKey, playLocal, isGreeting = () => false }) {
  const status = { enabled: false, listeningUntil: 0, phase: 'idle', lastHeard: null, lastReply: null, lastReplyAt: 0, lastError: null };
  const history = [];
  let busy = false, deafUntil = 0;
  let buf = Buffer.alloc(0), noise = null, calib = [], loud = 0, quietMs = 0, speaking = false, utter = [], preroll = [];
  let client = null;

  function anthropic() {
    const key = getApiKey();
    if (!key) throw new Error('No Anthropic API key — add it on the setup page');
    if (!client || client._key !== key) {
      const A = require('@anthropic-ai/sdk');
      client = new (A.default || A)({ apiKey: key, timeout: 20000, maxRetries: 1 });
      client._key = key;
    }
    return client;
  }

  const schema = {
    type: 'object',
    properties: {
      line: { type: 'string' },
      tone: { type: 'string', enum: ['normal', 'sweet', 'excited', 'whisper'] },
      lantern: { type: 'string', enum: ['calm', 'wary', 'ward', 'keep'] },
      move: { type: 'string', enum: Object.keys(MOVEMENT) },
      done: { type: 'boolean' },
    },
    required: ['line', 'tone', 'lantern', 'move', 'done'],
    additionalProperties: false,
  };

  const windowOpen = () => getConfig().converse.alwaysListen || Date.now() < status.listeningUntil;

  // Called with every raw mic block (16 kHz mono s16le).
  function onAudio(chunk) {
    if (!getConfig().converse.enabled) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= FRAME * 2) {
      const frame = buf.subarray(0, FRAME * 2); buf = buf.subarray(FRAME * 2);
      const level = rms(frame);
      if (noise === null) {
        calib.push(level);
        if (calib.length >= 50) noise = Math.max(60, calib.sort((a, b) => a - b)[25]);
        continue;
      }
      const threshold = Math.max(noise * 3.5, 300);
      const deaf = busy || isGreeting() || Date.now() < deafUntil || !windowOpen();
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
        if (lenMs - quietMs >= MIN_UTTER_MS) onUtterance(pcm).catch(e => { status.lastError = e.message; log(`conversation: ${e.message}`); });
      }
    }
  }

  async function onUtterance(pcm) {
    if (busy) return;
    busy = true;
    try {
      status.phase = 'transcribing';
      const t0 = Date.now();
      const heard = await transcribe(pcm);
      // whisper "hears" these in plain room noise — never answer them.
      if (!heard || heard.length < 2 || /^(you|thank you|thanks for watching)[.!]?$/i.test(heard)) return;
      status.lastHeard = heard;
      log(`heard: "${heard}"`);
      await reply(`Visitor says: "${heard}"`, t0);
    } finally {
      busy = false;
      status.phase = windowOpen() ? 'listening' : 'idle';
    }
  }

  async function reply(turn, t0 = Date.now()) {
    status.phase = 'thinking';
    const cfg = getConfig();
    const messages = [...history, { role: 'user', content: turn }];
    const response = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 400,
      output_config: { format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: persona(cfg.converse.about), cache_control: { type: 'ephemeral' } }],
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer that one');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const choice = JSON.parse(text);
    history.push({ role: 'user', content: turn }, { role: 'assistant', content: text });
    while (history.length > HISTORY_TURNS * 2) history.splice(0, 2);
    const tClaude = Date.now() - t0;

    const line = String(choice.line || '').trim();
    if (!line) { log('(not for her — no reply)'); return; }
    status.phase = 'speaking';
    status.lastReply = line;
    status.lastReplyAt = Date.now();
    await speak(line, choice);
    log(`replied: "${line}"  (${tClaude} ms to write)`);
    if (choice.done) { status.listeningUntil = 0; history.length = 0; }
    else openWindow();
  }

  async function speak(line, { tone = 'normal', lantern = 'keep', move = 'head_and_eyes' } = {}) {
    const key = getElevenKey(), voiceId = getConfig().voiceId;
    if (!key || !voiceId) throw new Error('No ElevenLabs key/voice — she cannot speak a written reply');
    const st = lily.status();
    const audio = elevenTts(line, voiceId, key, TONES[tone] ? tone : 'normal');
    if (st.connected) {
      if (lantern && lantern !== 'keep') lily.setMood(lantern).catch(() => {});
      if (st.armed && move) lily.move(move).catch(() => {});
    }
    const file = path.join(os.tmpdir(), `greeter-reply-${Date.now()}.mp3`);
    fs.writeFileSync(file, await audio);
    try {
      if (st.audio && st.audio.connected) await lily.playFile(file);
      else await playLocal(file);
    } finally {
      deafUntil = Date.now() + TAIL_MS;
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  function openWindow() {
    const secs = getConfig().converse.windowSec;
    status.listeningUntil = Date.now() + secs * 1000;
    if (status.phase === 'idle') status.phase = 'listening';
  }

  return {
    onAudio,
    // A greeting just finished: start a fresh conversation and listen.
    afterGreeting(line) {
      if (!getConfig().converse.enabled) return;
      history.length = 0;
      if (line) history.push({ role: 'user', content: '(A visitor just walked in.)' },
        { role: 'assistant', content: JSON.stringify({ line, tone: 'normal', lantern: 'calm', move: 'all', done: false }) });
      deafUntil = Date.now() + TAIL_MS;
      openWindow();
    },
    // Setup-page test: type what a visitor said, hear her answer.
    async ask(text) {
      if (busy) throw new Error('She is busy answering');
      busy = true;
      try { await reply(`Visitor says: "${text}"`); }
      finally { busy = false; status.phase = windowOpen() ? 'listening' : 'idle'; }
      return status.lastReply;
    },
    // Mid-conversation: a new camera/chime greeting would talk over it.
    inConversation: () => busy || Date.now() - status.lastReplyAt < getConfig().converse.windowSec * 1000,
    warmup() { if (getConfig().converse.enabled) ensureWhisperServer(); },
    status: () => ({
      ...status,
      enabled: !!getConfig().converse.enabled,
      listening: getConfig().converse.enabled && windowOpen(),
      secondsLeft: Math.max(0, Math.round((status.listeningUntil - Date.now()) / 1000)),
      whisper: fs.existsSync(path.join(os.homedir(), 'whisper.cpp', 'build', 'bin', 'whisper-cli')),
    }),
  };
}

module.exports = { createConverse };
