// ─── Jasper & Edgar lines on Llama — built to hide Llama's lag ────────────────
//
// Llama needs ~6 s per line on this CPU, so nothing here makes a guest wait:
//
//   1. LINE BANK. Lines that don't depend on what anyone just said (thunder,
//      lightning, fog, banter, quiet muttering) are written AHEAD of time, a
//      couple per character per kind, for the CURRENT storm stage and the NEXT
//      one. take() is instant; the bank refills in the background.
//   2. REACTIONS. When Evelina, Lenora or Lily is about to speak, her line is
//      known before it plays, so react() starts writing the skeleton's answer
//      immediately; it is ready by the time her line finishes.
//
// Prompts are built from CHARACTER_BIBLE, carry the unmarked-grave guardrail
// (parity with the Claude path) plus a Llama-specific reinforcement — the
// first test failed by being evasive — and every stage register, so the
// storm-stage tone rule lives INSIDE the prompt, not in a second call.

'use strict';

const KINDS = ['thunder', 'lightning', 'fog', 'banter', 'quiet_mutter'];
const BANK_PER_SLOT = 2;
const RECENT_MAX = 30;

const KIND_EVENT = {
  thunder: 'Thunder just rolled across the cemetery.',
  lightning: 'Lightning just flashed over the graves.',
  fog: 'Fog is rolling in over the graves.',
  banter: 'A lull. You and the other skeleton needle each other.',
  quiet_mutter: 'Nobody is around. Mutter something to yourself or the other skeleton.',
};

// Small models follow examples far better than rules. This is the Llama-side
// reinforcement of GUARDRAIL_UNMARKED_GRAVE (which stays the single source of
// the rule itself).
const GRAVE_REINFORCEMENT =
  'If the unmarked grave ever comes up, answer flatly, as if it were any other headstone, and carry on. ' +
  'RIGHT: "That one? Just a grave. Place is full of them." ' +
  'WRONG (evasive): "Oh, just... nobody\'s, don\'t worry about it." ' +
  'WRONG (curious): "Now that you mention it, that grave IS strange..." ' +
  'Never hedge, never trail off, never change the subject on purpose, never wonder about it.';

function systemPrompt(id, c, other, guardrail) {
  const reg = c.stormStageRegister || {};
  const stages = Object.keys(reg).filter(k => k !== 'note').map(k => `- ${k}: ${reg[k]}`).join('\n');
  return [
    `You are ${c.name}, "${c.title}", one of two skeletons at Thornfield Cemetery (est. 1724) on Halloween night, ` +
    `during the Hollow Storm. You stand behind the witches Evelina (confident, driving the ritual) and Lenora ` +
    `(wise, dry), with Lily (a lantern-bearing witch) nearby. Guests see you but do not talk to you; you talk ` +
    `to ${other}, react to the witches, to Lily and to the storm, and sometimes call out to the yard.`,
    `Personality: ${c.personality} ${c.goal || ''}`.trim(),
    `Speech: ${c.speechStyle}`,
    c.relationships ? `With ${other}: ${Object.values(c.relationships)[0]}` : '',
    `Your tone depends on the storm stage. Follow the register for the stage you are given:\n${stages}`,
    'Reply with ONE short spoken line, under 18 words. No quotation marks, no stage directions, no actions ' +
    'in asterisks, no name labels. If the register says silence is right, reply with exactly: ...',
    guardrail,
    GRAVE_REINFORCEMENT,
  ].filter(Boolean).join('\n\n');
}

// Llama decorates. Strip it down to one clean spoken line, or null = silence.
function cleanLine(text, name) {
  let t = String(text || '').split('\n').find(l => l.trim()) || '';
  t = t.replace(new RegExp(`^\\s*(${name}|jasper|edgar)\\s*:\\s*`, 'i'), '')
    .replace(/\*[^*]*\*/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || /^\.+$/.test(t) || t.length < 2) return null;
  const sentences = t.match(/[^.!?…]+[.!?…]*/g) || [t];
  return sentences.slice(0, 2).join('').trim();
}

function createSkeletonLines({ llama, bible, guardrail, getStage, stageNames, log = console.log, quiet = () => false }) {
  const chars = {
    jasper: { c: bible.characters.jasper, other: 'Edgar' },
    edgar: { c: bible.characters.edgar, other: 'Jasper' },
  };
  const system = {};
  for (const id of Object.keys(chars)) system[id] = systemPrompt(id, chars[id].c, chars[id].other, guardrail);

  const bank = {};        // `${id}|${stage}|${kind}` -> [lines]
  const recent = { jasper: [], edgar: [] };
  let refilling = false;
  let lastReactor = 'edgar';

  const key = (id, stage, kind) => `${id}|${stage}|${kind}`;

  async function write(id, stage, event, priority) {
    const t0 = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await llama.chat([
        { role: 'system', content: system[id] },
        { role: 'user', content: `Storm stage: ${stage}.\n${event}\nYour line:` },
      ], { priority, maxTokens: 48 });
      const line = cleanLine(text, chars[id].c.name);
      // Repeats sound robotic over a 5-hour night; one retry, then accept.
      if (line && recent[id].includes(line.toLowerCase()) && attempt === 0) continue;
      if (line) { recent[id].push(line.toLowerCase()); if (recent[id].length > RECENT_MAX) recent[id].shift(); }
      return { character: id, line, stage, engine: 'llama', ms: Date.now() - t0 };
    }
    return { character: id, line: null, stage, engine: 'llama', ms: Date.now() - t0 };
  }

  // ── Background-cast group reaction (owner spec 2026-10-25) ────────────────
  // ONE Llama call returns 1-2 reactions (Jasper and/or Edgar, ~20 words each)
  // as structured JSON. Fixed short system prompt (prefix-cached); the stage,
  // its NUMBER and both registers are filled in by code per call. The crowd's
  // inner voice: they never talk to guests, they react to the hosts/Evelina.
  const groupSystem = [
    'You write reactions for two skeletons at Thornfield Cemetery on Halloween night, during the Hollow Storm. ' +
    'They stand behind the hosts (Lily, and Bob the skeleton showman) and the witch Evelina, and react like the ' +
    "crowd's inner voice: they never speak to guests directly.",
    `Jasper: ${chars.jasper.c.personality} ${chars.jasper.c.speechStyle} He calls out storm stages by NUMBER.`,
    `Edgar: ${chars.edgar.c.personality} ${chars.edgar.c.speechStyle} He mocks Jasper and jokes that the hosts are over-dramatic.`,
    'Write 1 or 2 reactions, each under 20 words, as JSON. No stage directions, no quotation marks, no names inside the line. ' +
    'If the register says Edgar is silent, leave him out.',
    guardrail,
    GRAVE_REINFORCEMENT,
  ].filter(Boolean).join('\n\n');
  const groupFormat = {
    type: 'object',
    properties: {
      reactions: {
        type: 'array', minItems: 1, maxItems: 2,
        items: { type: 'object', properties: { who: { type: 'string', enum: ['jasper', 'edgar'] }, line: { type: 'string' } }, required: ['who', 'line'] },
      },
    },
    required: ['reactions'],
  };
  const register = (id, stage) => (chars[id].c.stormStageRegister || {})[stage] || '';

  const api = {
    KINDS,
    // [{ character, line }] — 1-2 skeletons reacting to `line` said by `to`.
    async reactGroup({ to, line, stage = getStage(), stageNumber }) {
      const who = { evelina: 'Evelina', lenora: 'Lenora', lily: 'Lily', bob: 'Bob' }[String(to).toLowerCase()] || to;
      const user = `Storm stage ${stageNumber || (stageNames.indexOf(stage) + 1)} of ${stageNames.length}: ${stage}.\n` +
        `Jasper's register now: ${register('jasper', stage)}\nEdgar's register now: ${register('edgar', stage)}\n` +
        `${who} just said: "${String(line).slice(0, 300)}"\nReact.`;
      const { text } = await llama.chat([{ role: 'system', content: groupSystem }, { role: 'user', content: user }],
        { priority: llama.PRIORITY.reaction, maxTokens: 110, format: groupFormat });
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { return []; }
      const out = [];
      for (const r of (parsed.reactions || []).slice(0, 2)) {
        const id = String(r.who || '').toLowerCase();
        if (!chars[id] || out.some(o => o.character === id)) continue;
        const clean = cleanLine(r.line, chars[id].c.name);
        if (clean) out.push({ character: id, line: clean });
      }
      return out;
    },
    systemPrompt: (id) => system[id],

    // Direct generation (test tab, or anything without a bank slot).
    line({ character, kind = 'banter', stage = getStage(), event }) {
      if (!chars[character]) return Promise.reject(new Error(`No Llama prompt for "${character}"`));
      return write(character, stage, event || KIND_EVENT[kind] || KIND_EVENT.banter, llama.PRIORITY.live);
    },

    // Instant: a pre-written line for the current stage, or null if the bank is
    // empty (the caller plays nothing / a cached clip — it never waits on Llama).
    take({ character, kind }) {
      const stage = getStage();
      const slot = bank[key(character, stage, kind)];
      const line = slot && slot.length ? slot.shift() : null;
      setImmediate(api.refill);
      return line ? { character, line, stage, kind, engine: 'llama', fromBank: true } : null;
    },

    // Start writing a skeleton's answer to a line that is ABOUT to be spoken.
    // Returns a promise; await it when her line finishes playing.
    react({ to, line, stage = getStage(), character }) {
      let id = character;
      if (!id) {
        // Alternate, but Edgar goes nearly silent at the Grand Ritual.
        id = lastReactor === 'jasper' ? 'edgar' : 'jasper';
        if (stage === 'Grand Ritual' && id === 'edgar' && Math.random() < 0.7) id = 'jasper';
      }
      lastReactor = id;
      const who = { evelina: 'Evelina', lenora: 'Lenora', lily: 'Lily', bob: 'Bob' }[String(to).toLowerCase()] || to;
      return write(id, stage, `${who} just said: "${String(line).slice(0, 300)}"\nReact to it.`, llama.PRIORITY.reaction);
    },

    // Keep BANK_PER_SLOT lines per character/kind for the current and next
    // stage. One line at a time, and only while nothing more urgent is queued.
    async refill() {
      if (refilling || quiet()) return;   // quiet(): CPU reserved (Lily is listening)
      refilling = true;
      try {
        const cur = getStage();
        const idx = stageNames.indexOf(cur);
        const stages = [cur, stageNames[(idx + 1) % stageNames.length]];
        for (const stage of stages) {
          for (const kind of KINDS) {
            for (const id of Object.keys(chars)) {
              const k = key(id, stage, kind);
              bank[k] = bank[k] || [];
              if (bank[k].length >= BANK_PER_SLOT) continue;
              if (llama.status().queued > 0) return;        // live work first
              const r = await write(id, stage, KIND_EVENT[kind], llama.PRIORITY.bank);
              if (r.line) bank[k].push(r.line);
              return setImmediate(() => { refilling = false; api.refill(); });
            }
          }
        }
      } catch (e) {
        // AbortError = a live request pre-empted this bank line; it retries later.
        if (e.name !== 'AbortError') log(`line bank refill failed: ${e.message}`);
      } finally {
        refilling = false;
      }
    },

    status() {
      const cur = getStage();
      const counts = {};
      for (const id of Object.keys(chars)) {
        counts[id] = {};
        for (const kind of KINDS) counts[id][kind] = (bank[key(id, cur, kind)] || []).length;
      }
      return { stage: cur, perSlot: BANK_PER_SLOT, counts };
    },
  };
  return api;
}

module.exports = { createSkeletonLines, KINDS };
