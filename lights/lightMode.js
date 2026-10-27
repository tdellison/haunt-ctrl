// ─── Lights-only mode (owner spec 2026-10-26) ─────────────────────────────────
//
// Play with the Govee spotlights on any non-Halloween night: no AI, no mic, no
// API cost. Manual start/stop only. Each spotlight PAIR (skeleton, witch) is
// ONE channel (a tethered pair is one controller on one IP), set separately:
// on/off, brightness, and either a plain colour (steady or breathing) or an
// effect (Fire, Witch). Two-pair effects (Spirit Drift, Coven Pulse) take over
// both pairs until switched off. Storm flash = white on every lit light every
// 12 minutes, then back to whatever was running.
//
// Smooth by construction: every look is a function of time, sampled 10x/s and
// sent only when it changes. Brightness slider = the device's brightness
// (sent once, on change); the effect's motion rides in the RGB values (scaled
// 0-1), so each tick is at most ONE packet per light — well under the 20/s
// a Govee controller tolerates. A packet still queued for a light means the
// next tick for that light is skipped (latest look wins, no backlog).
//
// The A19 bulbs (cauldron/monument) are not waterproof: never touched here
// unless `bulbs` is switched on, and nothing errors when they have no IP.

'use strict';

const fs = require('fs');

const TICK_MS = 100;                       // 10 updates/s — never faster
const STORM_FLASH_EVERY_MS = 12 * 60 * 1000;
const STORM_FLASH_MS = 400;
const PAIRS = ['skeleton', 'witch'];
const SINGLE_EFFECTS = ['color', 'breathe', 'fire', 'witch'];
const TWO_PAIR_EFFECTS = ['drift', 'coven', 'blood', 'ecto'];
// Four-light themes: each spotlight on its own (needs per-segment control —
// unlocked by the single light test).
const SEGMENT_EFFECTS = ['blood', 'ecto'];

// ── Per-light control: Govee "ptReal" over LAN ───────────────────────────────
// Undocumented but widely used (govee2mqtt, govee-lan-bridge): the controller's
// own Bluetooth-style 20-byte frames, base64'd, in {cmd:'ptReal'} to UDP 4003.
// Segment colour frame: 33 05 15 01 RR GG BB 00 00 00 00 00 <mask lo> <mask hi>
// ... zero-padded to 19 bytes, byte 20 = XOR of the first 19. Mask bit n =
// segment n+1. On a spotlight 2-pack, segment 1 / 2 = light 1 / 2 (to be
// confirmed on the real lights by the single light test).
function segmentFrame(rgb, mask) {
  const b = Buffer.alloc(20);
  b.set([0x33, 0x05, 0x15, 0x01, rgb.r, rgb.g, rgb.b, 0, 0, 0, 0, 0, mask & 0xff, (mask >> 8) & 0xff]);
  let x = 0; for (let i = 0; i < 19; i++) x ^= b[i];
  b[19] = x;
  return b.toString('base64');
}
const ptReal = (frames) => ({ cmd: 'ptReal', data: { command: frames } });

const FIRE_PALETTE = [
  { r: 255, g: 80, b: 0 }, { r: 255, g: 40, b: 0 }, { r: 200, g: 30, b: 0 },
  { r: 255, g: 120, b: 0 }, { r: 255, g: 160, b: 20 },
];
const WITCH_PURPLE = { r: 100, g: 0, b: 180 };
const DRIFT_BASE = { r: 0, g: 242, b: 254 };       // cold teal #00F2FE
const DRIFT_ACCENTS = [{ r: 148, g: 0, b: 211 }, { r: 0, g: 255, b: 135 }];  // violet #9400D3, green #00FF87
const COVEN_BASE = { r: 0, g: 0, b: 139 };         // deep blue #00008B
const SAPPHIRE = { r: 15, g: 82, b: 186 };
const MAGENTA = { r: 255, g: 0, b: 255 };

const DEFAULTS = {
  pairs: {
    skeleton: { on: true, effect: 'fire', color: { r: 255, g: 80, b: 0 }, bri: 60 },
    witch: { on: true, effect: 'witch', color: { r: 100, g: 0, b: 180 }, bri: 60 },
  },
  twoPair: null,          // null | 'drift' | 'coven' | 'blood' | 'ecto'
  segments: null,         // per-light control: null = untested, true = works, false = doesn't
  // Yard order left -> right: [pair, segment]. Light 1-4 in the themes.
  order: [['skeleton', 0], ['skeleton', 1], ['witch', 0], ['witch', 1]],
  stormFlash: false,
  bulbs: false,           // A19 bulbs: off unless switched on
  ambient: false,         // quiet ambient loop
  // Daily auto on/off (owner, 2026-10-26: 4:30 pm - midnight, Utah time, the
  // nights before Halloween; Halloween itself is started by hand).
  schedule: { enabled: false, on: '16:30', off: '00:00', tz: 'America/Denver' },
};

// "HH:MM" -> minutes after midnight in the schedule's time zone, right now.
function localMinutes(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return get('hour') * 60 + get('minute');
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return (h % 24) * 60 + (m || 0); };
// Inside [on, off), allowing the window to cross midnight.
function inWindow(now, on, off) { return on <= off ? now >= on && now < off : now >= on || now < off; }

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => ({ r: lerp(c1.r, c2.r, t), g: lerp(c1.g, c2.g, t), b: lerp(c1.b, c2.b, t) });
const scale = (c, k) => ({ r: c.r * k, g: c.g * k, b: c.b * k });
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };   // ease in/out
const rand = (a, b) => a + Math.random() * (b - a);

function createLightMode({ file, pairIps, bulbIps, send, queued, log = console.log, onChange = () => {},
  beforeStart = () => {}, ambient = { start() {}, stop() {} } }) {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg = { ...cfg, ...saved, pairs: { ...cfg.pairs } };
    for (const p of PAIRS) cfg.pairs[p] = { ...DEFAULTS.pairs[p], ...(saved.pairs || {})[p] };
    cfg.schedule = { ...DEFAULTS.schedule, ...(saved.schedule || {}) };
  } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log(`light mode save failed: ${e.message}`); } };

  let running = false;
  let timer = null;
  let stormTimer = null;
  let nextFlashAt = null;
  let flashing = false;
  const sent = {};       // ip -> { color: 'r,g,b', bri, on }
  const fire = {};       // pair -> { from, to, start, dur, next }
  const t0 = Date.now();

  // ── Looks: each returns { color, level 0-1 } for a pair at time t ─────────
  function fireLook(pair, t) {
    let f = fire[pair];
    if (!f) f = fire[pair] = { from: { ...FIRE_PALETTE[0], level: 0.5 }, to: { ...FIRE_PALETTE[0], level: 0.5 }, start: t, dur: 1, next: t };
    if (t >= f.next) {
      // Irregular flicker: mostly normal, sometimes a flare or a smoulder; a
      // short fade (never a jump) into each new flame.
      const cur = fireAt(f, t);
      const roll = Math.random();
      const level = roll < 0.1 ? rand(0.85, 1) : roll < 0.2 ? rand(0.2, 0.32) : rand(0.45, 0.75);
      const c = FIRE_PALETTE[Math.floor(Math.random() * FIRE_PALETTE.length)];
      const hold = rand(250, 1400);
      f.from = cur; f.to = { ...c, level }; f.start = t; f.dur = Math.min(300, hold * 0.6); f.next = t + hold;
    }
    const c = fireAt(f, t);
    return { color: { r: c.r, g: c.g, b: c.b }, level: c.level };
  }
  function fireAt(f, t) {
    const k = smooth((t - f.start) / f.dur);
    return { ...mix(f.from, f.to, k), level: lerp(f.from.level, f.to.level, k) };
  }

  // Slow deep-purple breathing, ~8 s per breath.
  const witchLook = (t) => ({ color: WITCH_PURPLE, level: 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / 8000)) });
  // Any colour breathing, ~6 s per breath.
  const breatheLook = (c, t) => ({ color: c, level: 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / 6000)) });

  // Spirit Drift: teal at ~20%; an accent rises on one pair (2 s), holds 1.5 s,
  // and fades back while the other pair rises. Two steps, then the accent
  // swaps (violet <-> green).
  const DRIFT_FADE = 2000, DRIFT_HOLD = 1500, DRIFT_STEP = DRIFT_FADE + DRIFT_HOLD;
  function driftLook(pair, t) {
    const step = Math.floor(t / DRIFT_STEP);
    const inStep = t % DRIFT_STEP;
    const active = step % 2 === 0 ? 'skeleton' : 'witch';
    const accent = DRIFT_ACCENTS[Math.floor(step / 2) % DRIFT_ACCENTS.length];
    const prevAccent = DRIFT_ACCENTS[Math.floor((step - 1) / 2) % DRIFT_ACCENTS.length] || accent;
    const rise = smooth(inStep / DRIFT_FADE);
    // The pair that held last step is fading back down during this step's rise.
    const k = pair === active ? rise : 1 - rise;
    const acc = pair === active ? accent : prevAccent;
    return { color: mix(DRIFT_BASE, acc, k), level: lerp(0.2, 0.85, k) };
  }

  // Coven Pulse: deep-blue baseline; the pairs breathe 15-80% out of sync,
  // drifting between sapphire and magenta.
  function covenLook(pair, t) {
    const off = pair === 'skeleton' ? 0 : Math.PI;
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / 7000 + off);     // breath
    const hue = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / 23000 + off);  // sapphire <-> magenta
    return { color: mix(COVEN_BASE, mix(SAPPHIRE, MAGENTA, hue), w), level: lerp(0.15, 0.8, w) };
  }

  // ── Four-light themes (owner spec 2026-10-27) ─────────────────────────────
  // Blood & Lightning: crimson/shadow breathing, each light on its own period
  // and phase so the shadows warp and lean; now and then ONE light is struck:
  // white pop -> black -> icy aftershock -> fades back into the heartbeat.
  const CRIMSON = { r: 0x8B, g: 0, b: 0 }, SHADOW = { r: 0x2A, g: 0, b: 0 };
  const BOLT = { r: 255, g: 255, b: 255 }, ICY = { r: 0xE0, g: 0xF7, b: 0xFA };
  const BLOOD_PERIODS = [5200, 6100, 4700, 5700];
  const BLOOD_PHASES = [0, 1.9, 3.7, 5.1];
  let strike = null, nextStrikeAt = 0;
  function bloodLook(i, t) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / BLOOD_PERIODS[i] + BLOOD_PHASES[i]);
    const base = { color: mix(SHADOW, CRIMSON, w), level: lerp(0.35, 1, w) };
    if (!strike || strike.light !== i) return base;
    const d = t - strike.at;
    if (d < 180) return { color: BOLT, level: 1 };          // primary bolt — a pop, not a fade
    if (d < 380) return { color: { r: 0, g: 0, b: 0 }, level: 0 };   // total black
    if (d < 560) return { color: ICY, level: 1 };           // aftershock
    if (d < 1600) { const k = smooth((d - 560) / 1040); return { color: mix(ICY, base.color, k), level: lerp(1, base.level, k) }; }
    strike = null;
    return base;
  }
  function bloodStrikes(t) {
    if (!nextStrikeAt) nextStrikeAt = t + rand(15000, 45000);
    if (!strike && t >= nextStrikeAt) {
      strike = { light: Math.floor(Math.random() * 4), at: t };
      nextStrikeAt = t + rand(15000, 60000);               // asynchronous, never on a beat
    }
  }

  // Ectoplasmic Ghost Drift: cold corpse-cyan base; a bright ectoplasm-green
  // or witch-violet wave rolls light 1 -> 2 -> 3 -> 4 so the shadows slide
  // along the walls, rests, then the next phantom (other colour) comes through.
  const CORPSE = { r: 0, g: 0xF2, b: 0xFE };
  const ECTO_ACCENTS = [{ r: 0x39, g: 0xFF, b: 0x14 }, { r: 0x94, g: 0, b: 0xD3 }];
  const ECTO_PASS = 5000, ECTO_REST = 2500;
  function ectoLook(i, t) {
    const cycle = ECTO_PASS + ECTO_REST;
    const n = Math.floor(t / cycle), d = t % cycle;
    const accent = ECTO_ACCENTS[n % ECTO_ACCENTS.length];
    const pos = -1 + 5 * (d / ECTO_PASS);                   // enters before light 1, leaves after light 4
    const k = d < ECTO_PASS ? Math.exp(-((pos - i) ** 2) / (2 * 0.55 ** 2)) : 0;
    return { color: mix(CORPSE, accent, k), level: lerp(0.3, 1, k) };
  }

  function lookFor(pair, t) {
    if (cfg.twoPair === 'drift') return driftLook(pair, t);
    if (cfg.twoPair === 'coven') return covenLook(pair, t);
    const p = cfg.pairs[pair];
    if (p.effect === 'fire') return fireLook(pair, t);
    if (p.effect === 'witch') return witchLook(t);
    if (p.effect === 'breathe') return breatheLook(p.color, t);
    return { color: p.color, level: 1 };
  }

  // ── Output ────────────────────────────────────────────────────────────────
  function put(ip, cmd, data, priority = 2) {
    return send(ip, { cmd, data }, priority).catch(() => {});
  }
  function setPower(ip, on) {
    const s = sent[ip] = sent[ip] || {};
    if (s.on === on) return;
    s.on = on;
    put(ip, 'turn', { value: on ? 1 : 0 }, 1);
  }
  function setBri(ip, bri) {
    const s = sent[ip] = sent[ip] || {};
    if (s.bri === bri) return;
    s.bri = bri;
    put(ip, 'brightness', { value: bri }, 1);
  }

  // Four lights: one ptReal per controller per tick carrying both its lights.
  function segmentTick(t) {
    if (cfg.twoPair === 'blood') bloodStrikes(t);
    const byIp = {};
    cfg.order.forEach(([pair, seg], i) => {
      const ip = pairIps(pair)[0];
      if (!ip) return;
      const look = cfg.twoPair === 'blood' ? bloodLook(i, t) : ectoLook(i, t);
      const c = scale(look.color, clamp01(look.level));
      (byIp[ip] = byIp[ip] || { pair, segs: [] }).segs.push({ seg, rgb: { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) } });
    });
    for (const [ip, { pair, segs }] of Object.entries(byIp)) {
      const p = cfg.pairs[pair];
      setPower(ip, true);
      setBri(ip, Math.max(1, Math.min(100, Math.round(p.bri))));
      if (queued(ip) > 0) continue;
      const key = segs.map(s => `${s.seg}:${s.rgb.r},${s.rgb.g},${s.rgb.b}`).join('|');
      if (sent[ip].color === key) continue;
      sent[ip].color = key;
      send(ip, ptReal(segs.map(s => segmentFrame(s.rgb, 1 << s.seg))), 2).catch(() => {});
    }
  }

  // ── Single light test ─────────────────────────────────────────────────────
  // Both lights on each controller go red; 2 s later ONLY light 2 of each
  // should turn blue. The owner watches and reports pass/fail.
  let testing = false;
  async function singleTest() {
    const ips = PAIRS.flatMap(p => pairIps(p));
    if (!ips.length) throw new Error('No light IPs set');
    testing = true;
    for (const ip of ips) {
      await put(ip, 'turn', { value: 1 }, 0);
      await put(ip, 'brightness', { value: 100 }, 0);
      await put(ip, 'colorwc', { color: { r: 255, g: 0, b: 0 }, colorTemInKelvin: 0 }, 0);
    }
    setTimeout(() => { for (const ip of ips) send(ip, ptReal([segmentFrame({ r: 0, g: 0, b: 255 }, 0x02)]), 0).catch(() => {}); }, 2000);
    setTimeout(() => {
      testing = false;
      for (const ip of ips) if (sent[ip]) { delete sent[ip].color; delete sent[ip].bri; delete sent[ip].on; }
    }, 10000);
  }

  function tick() {
    if (!running) return;
    const t = Date.now() - t0;
    if (!flashing && !testing && SEGMENT_EFFECTS.includes(cfg.twoPair)) {
      segmentTick(t);
    } else if (!flashing && !testing) {
      for (const pair of PAIRS) {
        const p = cfg.pairs[pair];
        for (const ip of pairIps(pair)) {
          if (!p.on) { setPower(ip, false); continue; }
          setPower(ip, true);
          setBri(ip, Math.max(1, Math.min(100, Math.round(p.bri))));
          if (queued(ip) > 0) continue;     // still sending — latest look wins next tick
          const { color, level } = lookFor(pair, t);
          const c = scale(color, clamp01(level));
          const rgb = { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
          const key = `${rgb.r},${rgb.g},${rgb.b}`;
          if (sent[ip].color === key) continue;
          sent[ip].color = key;
          put(ip, 'colorwc', { color: rgb, colorTemInKelvin: 0 });
        }
      }
    }
    timer = setTimeout(tick, TICK_MS);
  }

  function applyBulbs() {
    for (const ip of bulbIps()) setPower(ip, !!cfg.bulbs && running);
  }

  // ── Storm flash ───────────────────────────────────────────────────────────
  async function flash() {
    if (flashing) return;
    const ips = [...PAIRS.filter(p => cfg.pairs[p].on).flatMap(p => pairIps(p)), ...(cfg.bulbs ? bulbIps() : [])];
    if (!ips.length) return;
    flashing = true;
    log('Lights-only: storm flash');
    await Promise.all(ips.map(ip => Promise.all([
      put(ip, 'colorwc', { color: { r: 255, g: 255, b: 255 }, colorTemInKelvin: 0 }, 0),
      put(ip, 'brightness', { value: 100 }, 0),
    ])));
    setTimeout(() => {
      // Forget what was sent so the next tick repaints every light.
      for (const ip of ips) if (sent[ip]) { delete sent[ip].color; delete sent[ip].bri; }
      flashing = false;
    }, STORM_FLASH_MS);
  }
  function scheduleStorm() {
    clearTimeout(stormTimer); stormTimer = null; nextFlashAt = null;
    if (!running || !cfg.stormFlash) return;
    nextFlashAt = Date.now() + STORM_FLASH_EVERY_MS;
    stormTimer = setTimeout(async () => { await flash(); scheduleStorm(); onChange(); }, STORM_FLASH_EVERY_MS);
  }

  // ── Daily schedule ────────────────────────────────────────────────────────
  // Acts only when the clock CROSSES the on/off time, so tapping OFF mid-evening
  // sticks until tomorrow's on time. At boot (or when switched on) inside the
  // window, the lights come on — a restart never leaves the yard dark.
  let lastInside = null;
  function scheduleCheck() {
    const sc = cfg.schedule;
    if (!sc.enabled) { lastInside = null; return; }
    let inside;
    try { inside = inWindow(localMinutes(sc.tz), toMin(sc.on), toMin(sc.off)); } catch (e) { log(`schedule: ${e.message}`); return; }
    if (inside && lastInside !== true && !running) {
      try { api.start(); log(`Lights-only: scheduled ON (${sc.on}-${sc.off})`); }
      catch (e) { log(`Lights-only: scheduled start skipped — ${e.message}`); }
    } else if (!inside && lastInside === true && running) {
      api.stop(); log('Lights-only: scheduled OFF');
    }
    lastInside = inside;
  }
  setInterval(scheduleCheck, 30000);
  setTimeout(scheduleCheck, 5000);

  const api = {
    PAIRS, SINGLE_EFFECTS, TWO_PAIR_EFFECTS,
    get running() { return running; },
    get bulbs() { return !!cfg.bulbs; },

    start() {
      if (running) return api.status();
      beforeStart();                    // throws if the show is running
      running = true;
      for (const k of Object.keys(sent)) delete sent[k];
      tick();
      applyBulbs();
      scheduleStorm();
      if (cfg.ambient) ambient.start();
      log('Lights-only mode ON (no AI)');
      onChange();
      return api.status();
    },

    // Off button: stop the engine and switch the spotlights off.
    stop({ lightsOff = true } = {}) {
      if (!running) return api.status();
      running = false;
      clearTimeout(timer); clearTimeout(stormTimer); timer = stormTimer = null; nextFlashAt = null;
      if (lightsOff) {
        for (const ip of PAIRS.flatMap(p => pairIps(p))) put(ip, 'turn', { value: 0 }, 1);
        if (cfg.bulbs) for (const ip of bulbIps()) put(ip, 'turn', { value: 0 }, 1);
      }
      if (cfg.ambient) ambient.stop();
      log('Lights-only mode OFF');
      onChange();
      return api.status();
    },

    // Per-pair settings: { on, effect, color:{r,g,b} | '#rrggbb', bri }
    setPair(pair, patch = {}) {
      if (!PAIRS.includes(pair)) throw new Error(`Unknown pair "${pair}" — use ${PAIRS.join('/')}`);
      const p = cfg.pairs[pair];
      if (patch.on !== undefined) p.on = !!patch.on;
      if (patch.effect !== undefined) {
        if (!SINGLE_EFFECTS.includes(patch.effect)) throw new Error(`Unknown effect "${patch.effect}"`);
        p.effect = patch.effect;
        cfg.twoPair = null;             // picking a single effect releases a two-pair effect
      }
      if (patch.color !== undefined) p.color = parseColor(patch.color);
      if (patch.bri !== undefined) p.bri = Math.max(1, Math.min(100, Math.round(Number(patch.bri) || 1)));
      save(); onChange();
      return api.status();
    },

    async singleTest() { await singleTest(); return api.status(); },
    setSegments(ok) { cfg.segments = !!ok; if (!ok && SEGMENT_EFFECTS.includes(cfg.twoPair)) cfg.twoPair = null; save(); onChange(); return api.status(); },
    setOrder(order) {
      const valid = Array.isArray(order) && order.length === 4 && order.every(o => Array.isArray(o) && PAIRS.includes(o[0]) && (o[1] === 0 || o[1] === 1));
      if (!valid) throw new Error('order must be 4 × [pair, 0|1]');
      cfg.order = order; save(); onChange(); return api.status();
    },

    setTwoPair(effect) {
      if (effect && !TWO_PAIR_EFFECTS.includes(effect)) throw new Error(`Unknown two-pair effect "${effect}"`);
      if (SEGMENT_EFFECTS.includes(effect) && cfg.segments !== true) throw new Error('Run the single light test first — this theme needs each light controlled on its own');
      cfg.twoPair = effect || null;
      if (cfg.twoPair) for (const p of PAIRS) cfg.pairs[p].on = true;
      save(); onChange();
      return api.status();
    },

    allOff() {
      for (const p of PAIRS) cfg.pairs[p].on = false;
      cfg.twoPair = null;
      save(); onChange();
      if (!running) for (const ip of PAIRS.flatMap(p => pairIps(p))) put(ip, 'turn', { value: 0 }, 1);
      return api.status();
    },

    setStormFlash(on) { cfg.stormFlash = !!on; save(); scheduleStorm(); onChange(); return api.status(); },
    async flashNow() { if (!running) throw new Error('Start Lights-only mode first'); await flash(); return api.status(); },
    setBulbs(on) { cfg.bulbs = !!on; save(); if (running) applyBulbs(); onChange(); return api.status(); },
    setAmbient(on) {
      cfg.ambient = !!on; save();
      if (running) (cfg.ambient ? ambient.start : ambient.stop)();
      onChange();
      return api.status();
    },

    setSchedule({ enabled, on, off } = {}) {
      const ok = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t));
      if (on !== undefined) { if (!ok(on)) throw new Error('on time must be HH:MM'); cfg.schedule.on = on; }
      if (off !== undefined) { if (!ok(off)) throw new Error('off time must be HH:MM'); cfg.schedule.off = off; }
      if (enabled !== undefined) cfg.schedule.enabled = !!enabled;
      save(); lastInside = null; scheduleCheck(); onChange();
      return api.status();
    },

    status() {
      return {
        running, ...JSON.parse(JSON.stringify(cfg)), nextFlashAt,
        ips: Object.fromEntries(PAIRS.map(p => [p, pairIps(p)])), bulbIps: bulbIps(),
        effects: SINGLE_EFFECTS, twoPairEffects: TWO_PAIR_EFFECTS, segmentEffects: SEGMENT_EFFECTS, testing,
      };
    },
  };
  return api;
}

function parseColor(c) {
  if (typeof c === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) throw new Error(`Bad colour "${c}" — use #rrggbb`);
    const n = parseInt(m[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
  }
  const v = (x) => Math.max(0, Math.min(255, Math.round(Number(x) || 0)));
  return { r: v(c && c.r), g: v(c && c.g), b: v(c && c.b) };
}

module.exports = { createLightMode };
