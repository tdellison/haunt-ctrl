// ─── Engine routing — which AI writes which line ──────────────────────────────
//
// A fixed lookup, checked in plain code before any AI call. No AI decides the
// routing (that would cost a Claude call just to route). Change a row here and
// nothing else moves. Rule of thumb: anything touching a guest's speech, or
// rare / high-narrative-weight, is Claude; reactive, ambient, high-volume and
// low-stakes is Llama.
//
// Skeletons have NO PIR (2026-09-30): they sit behind the witches, are seen but
// not spoken to, and react to the witches, Lily and the storm.

'use strict';

// [character, trigger, engine]. '*' matches anything; first match wins.
const ROUTES = [
  // Special beats are always Claude, whoever speaks.
  ['*',       'special_beat',    'claude'],   // Blackout Storm, near-success, storm echo
  ['evelina', 'guest_mic',       'claude'],
  ['evelina', 'clue',            'claude'],   // frames the OWNER's clue lines, never invents
  ['evelina', 'quiet_mutter',    'llama'],
  ['evelina', '*',               'claude'],
  ['lily',    '*',               'claude'],   // guest mic, lantern reactions, crowd callouts, arguments
  ['lenora',  '*',               'claude'],   // incl. the once-per-season almost-truth line
  ['jasper',  '*',               'llama'],    // witch/Lily reactions, storm events, banter, muttering
  ['edgar',   '*',               'llama'],
  ['*',       'ambient_ack',     'llama'],    // 1-in-3 reaction to a background sound
  ['graveyard', '*',             'llama'],    // atmosphere pacing decisions
  ['director', 'heartbeat',      'claude'],
];

function resolveEngine(character, trigger) {
  const c = String(character || '').toLowerCase();
  const t = String(trigger || '').toLowerCase();
  for (const [rc, rt, engine] of ROUTES) {
    if ((rc === '*' || rc === c) && (rt === '*' || rt === t)) return engine;
  }
  return 'claude';
}

module.exports = { resolveEngine, ROUTES };
