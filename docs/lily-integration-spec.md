# Haunt-ctrl v3 — Master Build Summary for Claude Code
### Linux Migration → First Full Show Run-Through → Lily Integration

This document combines everything decided across planning conversations that has **not yet been confirmed as implemented in code**, plus the full Lily integration spec. Read top to bottom — it's ordered the way the work should actually happen.

> **Repo status annotations** (added when this doc was committed, 2026-09): items below marked ✅ were verified implemented on `master`; ⏳ = still open; 🔧 = groundwork built, hardware validation pending. Everything else is unchanged from the original planning doc.

---

# PART 1 — General haunt-ctrl v3 status & pending items (non-Lily)

## 1.1 Order of operations (Claude Code's part — Linux OS setup itself is handled separately by the owner, not part of this)

0. **Before the Linux migration happens: confirm the GitHub repo is fully up to date.** ✅ *(verified 2026-09: Dell working copy = origin/master, default branch fixed to master, runtime state committed.)* `git push` from PowerShell on the Windows box has been unreliable — historically this has needed Claude Code to hand-write PowerShell push commands to get commits up rather than a clean `git push` working on its own. Do a final check (`git status`, `git log` vs. `git log origin/master`) and push/resolve whatever's outstanding, generating PowerShell commands as needed the same way as before, so the Linux box clones a repo that actually reflects the current working code — not a stale version missing recent local changes.
1. **Once the Linux box is up and haunt-ctrl is ported over** (owner's own setup — Ubuntu install, static IP, systemd, base packages including `bluetoothctl`/`wpctl`/BLE prerequisites), confirm the server starts and talks to Onkyo/Govee/ESP32 exactly like the old machine. ⏳
2. **Run the FIRST full end-to-end show run-through ever** (this has never actually happened — do it in pieces first: each zone's lights/audio individually, each PIR manually, one storm cycle without guests, before attempting the full autonomous Start-Show loop). Expect this to surface real bugs — that's normal for a true first run, not a sign anything went wrong. ⏳
3. **Only after the show runs cleanly once**, begin Lily's BLE/audio work (Part 2 of this document).

## 1.2 Confirmed decisions already made (context, not action items)

- **STT:** whisper.cpp for this year (not faster-whisper) — lighter/better for CPU-only inference on the Linux box. Already installed and confirmed working via ffplay/ffmpeg on the current laptop.
- **Audio playback:** ffplay (part of ffmpeg) replacing VLC — confirmed installed, tested, and working (owl-hoot ambient sound test passed cleanly). ffmpeg is cross-platform so this same install carries over to Linux directly.
- **Blackout Storm sequence:** built from scratch (no code existed for it previously) and **tested successfully end-to-end** — confirmed working, including its dedicated unique spectral laugh sound (kept in the same `ambient-sounds` folder as everything else, matched by filename — no special folder needed). This spectral laugh is exclusive to Blackout Storm and must never play during Grand Ritual, which uses the regular evil-laugh-1/2/3 stingers from the normal ambient pool.
- **Dialogue transcript logging:** implemented — captures real show dialogue to `transcripts/` in JSONL format, per character and per show night, intended as future few-shot training material for next year's local LLM.
- **Asset path fix:** resolved a OneDrive-redirected-Desktop path bug by moving ambient sounds, storm audio, and voice files to a reliable local path (`C:\haunt-ctrl-assets\` on the current laptop) — confirm the equivalent local (non-cloud-synced) path is used on the new Linux box, don't let this regress.

## 1.3 Confirmed NOT yet implemented (real work items — same items flagged in two separate planning sessions, still open both times)

1. **Unmarked-grave guardrail — upgrade needed.** ✅ *(done: perceptual "cognitive blind spot" version, single `GUARDRAIL_UNMARKED_GRAVE` const in all 4 prompts + CHARACTER_BIBLE.unmarkedGrave.)* Current guardrail language lets characters notice-but-not-explain the grave. Decision made: upgrade to a stronger "cognitive blind spot" version — characters genuinely cannot perceive it as significant, not just "won't mention it." Needs to be written into Evelina/Lenora/Jasper/Edgar's system prompts.
2. **"Crypt" → "unmarked grave/monument" rename** ✅ *(verified: zero "crypt" hits anywhere in code/prompts/UI.)* — confirm no leftover "crypt" references remain anywhere in Blackout Storm dialogue or stage logic.
3. **Evelina's clue-pool tiering** ✅ *(structures built: `evelinaCluesVague`/`evelinaCluesPointed` + `pickEvelinaClue`, pointed from cycle 3; both pools intentionally EMPTY — owner writes the lines.)*
4. **Special-beat mutex flag** ✅ *(built: `cycleState.specialBeatFired` + `tryRollSpecialBeat`, reset on Distant entry; `seasonBeatsUsed` separately caps blackoutStorm and lenoraAlmostTruth at once per season. No Director exists yet to roll them.)*
5. **Storm stage collapse** ✅ *(built: canonical 5-stage `STRIKE_SEQUENCE`, Grand Ritual IS the peak — no separate Overhead stage.)*
6. **Storm-stage-linked skeleton behavior** ✅ *(built: `stormStageRegister` on Jasper and Edgar — stage is a REQUIRED input; presence decides whether, stage decides how.)*
7. **Candy narrative hook** ✅ *(built: `characters.evelina.candyGiving` — a warm transactional trade tied to her search; brisk with small trick-or-treaters, extendable with lingerers.)*
8. **Jasper's guest mic removal** ✅ *(done 2026-09: `hasMic:false` in CHARACTERS, bible/docs updated — PIR-presence reactive only; Evelina's is the only guest-facing mic.)*
9. **Payload/token audit** ⏳ *(partially N/A: token budget scaffolding exists — $9 cap, modes, model router — but NO Claude-API-calling code exists yet, so prompt caching cannot be "implemented" until the AI conductor/Director is built. Carry this audit into the conductor build: caching must ship WITH the first API-calling code, not after.)*
10. **Dead code audit** ⏳→✅ *(swept 2026-09: crypt clean, FX_FILES already deleted, `server.js.bak-202845` removed from the repo in this commit. Re-sweep after the conductor lands.)*

## 1.4 Explicitly deferred (do NOT do these yet — noted so they aren't mistaken for forgotten)

- **Async fallback wrapper + fallback dialogue** — intentionally held until *after* the Linux/Ollama build is stable. Do not implement early.
- **WebSocket dashboard upgrade** — a full WebSocket rewrite was drafted (push-based live updates instead of polling) but **explicitly not confirmed as needed yet**. The right first step is to diagnose whether the current dashboard lag is really a polling-interval problem or something else (e.g., a slow button handler) before committing to the WebSocket rewrite — don't build this speculatively.
- **Next-year hardware (GPU, Ollama/MythoMax local LLM, Kokoro local TTS, ESI GIGAPORT eX audio interface)** — all settled decisions for the *next* build cycle, not this year's Linux migration. Don't pull any of this forward.

---

# PART 2 — Lethal Lily Integration Spec

**Target system:** haunt-ctrl v3 (Node.js), running on the Linux box described in Part 1.
**Goal:** Add Lily (2026 Home Depot "Lethal Lily" animatronic — same electronics family as Ultra Skelly) into the existing multi-agent show, controlled over Bluetooth from an ESP32 (movement/lights) and the OptiPlex directly (audio).

This spec was built by porting the proven architecture from the open-source project
`TheDadTech/UltraSkellyAdvanced` (Python, MIT-adjacent, Raspberry Pi–targeted) into
our Node.js stack. Do not copy code verbatim — reimplement each piece in JS/TS.

**Important: the reference project targets Ultra Skelly, not Lethal Lily.** They share the same underlying SVI electronics/BLE protocol family (same service/characteristic UUIDs, same command framing and CRC-8), but Lily has real physical/behavioral differences from Ultra Skelly — the confirmed one so far being **no eye-color/icon changes** (see section 2.4). Treat every hardware-behavior assumption ported from this reference (eye capabilities, exact movement range, jaw behavior, Classic BT device naming, etc.) as **needs-verification-on-real-Lily-hardware**, not as guaranteed fact, even though the low-level protocol bytes themselves should carry over correctly.

---

## 2.0 Prerequisites before starting

- [ ] Linux confirmed running on the OptiPlex, with `bluetoothctl` (BlueZ) and `wpctl` (PipeWire/WirePlumber) available (`which bluetoothctl wpctl`).
- [ ] Node BLE library installed: `@abandonware/noble` (or equivalent cross-platform BLE lib that supports Linux BlueZ). 🔧 *(smoke-tested 2026-09 on Node 22/Linux: installs and native module compiles clean; runtime needs a real BlueZ host. Native binding is platform-compiled → OptiPlex needs a one-time `npm rebuild @abandonware/noble` on first setup, then commit the Linux-built result.)*
- [ ] Lily powered on and discoverable.
- [ ] Part 1's full show run-through completed successfully first — don't start Lily's BLE work on an unvalidated base system.

---

## 2.1 BLE GATT layer (movement, eyes, lighting, live-mode arm)

🔧 *Groundwork built pre-hardware: `lily/protocol.js` (constants, CRC-8, framing, all command builders, probe helpers) unit-tested by `lily/protocol.test.js`; `lily/mockLily.js` carries the safety-interlock contract. The live noble adapter, connection sequence, and auto-reconnect remain to be built per this section once the gates in 2.0 pass.*

### 2.1.1 Protocol constants

```
SERVICE_UUID = 0000ae00-0000-1000-8000-00805f9b34fb
WRITE_UUID   = 0000ae01-0000-1000-8000-00805f9b34fb
NOTIFY_UUID  = 0000ae02-0000-1000-8000-00805f9b34fb
```

### 2.1.2 Command framing

Every command is: **2-byte tag** (hex, always starts with `AA`) + **payload** (padded to a minimum byte length with trailing zeros) + **1-byte CRC-8 checksum**.

CRC-8 is **Dallas/Maxim** (polynomial `0x8C`, LSB-first):

```js
function crc8(bytes) {
  let result = 0;
  for (const b of bytes) {
    result ^= b;
    for (let i = 0; i < 8; i++) {
      result = (result & 1) ? ((result >> 1) ^ 0x8C) : (result >> 1);
    }
  }
  return result & 0xFF;
}
```

**Port this first and unit-test it in isolation** against known-good hex commands before wiring up any live BLE. A wrong bit-order/polynomial here means every command silently fails.

`buildCommand(tag, payloadHex, minimumPayloadBytes=8)`:
- Validate tag is 4 hex chars starting with `AA`.
- Pad payload (right-justified with zeros) to `minimumPayloadBytes * 2` hex chars.
- Concatenate tag + payload → bytes → append CRC-8 of those bytes.

*(Implementation note: "trailing zeros" and "right-justified" conflict — trailing-zero padding is what `lily/protocol.js` implements; verify against a known-good captured command on real hardware and flip if the prop NAKs.)*

### 2.1.3 Commands to implement

| Function | Tag | Notes |
|---|---|---|
| `setEyeIcon(index)` | `AAF9` | index 1–18, see icon table below — **NOT applicable to Lily, see 2.1.4** |
| `setMovement(action)` | `AACA` | action ∈ {0,1,2,4,5,6,7,255} — see movement table |
| `setClassicAudio(enabled)` | `AAFD` | 1 byte, 0x01/0x00 — arms/disarms the prop's Classic BT audio path |
| `setVolume(volume)` | `AAFA` | 0–100 |
| `queryVolume()` | `AAE5` | — |
| `queryVersion()` | `AAEE` | firmware version query, optional/non-fatal on connect |
| `setLightBrightness(channel, brightness)` | `AAF3` | channel 0=torso, 1=head; brightness 0–255 |
| `setLightRGB(channel, r, g, b, cycle)` | `AAF4` | same channels |
| `setLightMode(channel, mode)` | `AAF2` | mode 1=static, 2=strobe, 3=pulse |
| `playMediaFile(serial, enabled)` | `AAC6` | stored on-prop sound files, 2-byte serial |

Lighting is **three separate sequential writes** per color change (brightness, mode, RGB) — stagger with a small `await sleep(~50ms)` between writes; the firmware expects sequential, not batched, commands.

### 2.1.4 Eye icon table (index → name)

```
1 normal   2 hazel     3 green       4 brown      5 angry
6 gray     7 squint    8 orange_cat  9 spiral     10 fire
11 star    12 skull    13 fireworks  14 american_flag
15 hearts  16 clover   17 snowflake  18 confetti
```
**Note: Lily's eyes are physical/mechanical (they move — pan/tilt, blinking), not digital color/icon displays like Ultra Skelly's.** The `setEyeIcon()` GATT command controls a digital eye-icon display Lily does not have, so it does not apply to her. Mood/reaction state (calm vs. wary/agitated) should be conveyed **entirely through the lantern** (`setLightBrightness`/`setLightRGB`/`setLightMode`, section 2.1.3) since there's no eye-color channel to use for that.

### 2.1.5 Lantern mood/reaction behavior (character-driven, not just a color table)

Lily's lantern should read as **her own reaction**, distinct from Evelina's spell-effect palette (blue/amber-gold/green-purple/crimson — all already claimed by specific spells). Three lantern states:

- **Calm/approving:** default resting state during normal spellcasting.
- **Wary/agitated:** something is heading somewhere she doesn't like, but she hasn't intervened — distinct color from calm, distinct from Evelina's spell colors.
- **Protective ward-intervention:** triggers on a botched/anomalous spell moment (ties into the existing Wrong Storm Anomalies system and the spell-restart mechanic below). Suggested treatment: a sharp flare/strobe (`setLightMode` mode 2) to a **warm white / pale gold or silver-white** "ward" color — distinct from all spell colors — held for a beat, then settle into a static/pulse glow (mode 1 or 3) while she delivers a protective line. Reads as "she just threw something between Evelina and the danger," not a passive mood shift.

This is a character trait, not just a lighting effect — worth reflecting in the story bible under Lily's section, not only in code.

### 2.1.6 Movement table (name → byte)

```
none = 0
head_only = 1
arms_only = 2
torso_only = 4
head_and_torso = 5
torso_and_arms = 6
all = 255
```
Note: raw byte `7` was seen validated in the source protocol layer but has no named movement — possible undocumented combo, not required for launch but worth testing if extra granularity is wanted.

This confirms Lily's movement vocabulary should be treated as a **small fixed enum**, not freeform servo positions — matches our plan for Claude to pick from head L/C/R, arm gestures, etc. mapped onto this small set.

**Lily's confirmed physical range:** five independently servo-driven points —
- **Eyes:** wide pan/tilt range (not just side-to-side) plus independent blinking
- **Mouth:** real-time audio sync — range of motion scales dynamically with the pitch/volume of whatever audio is playing (preset dialogue, live mic, or custom uploaded tracks) — consistent with the audio-reactive-jaw theory in section 2.2.4, now more specifically an amplitude/pitch-driven envelope rather than a simple open/closed toggle
- **Head:** neck servo, fluid tilt and pan
- **Left arm & elbow:** lifts/lowers, positions the lantern
- **Left hand & wrist:** twists/pivots, swings the lantern

**Right arm is not called out as servo-driven** — treat it as static/non-articulated unless proven otherwise on real hardware.

**Architecture note — this is more granular than Ultra Skelly's simple movement enum.** The `Movement` enum above comes from the Ultra Skelly reference protocol and is a coarse bitfield. Lily's real servo layout has 5 independently-described points (eyes, mouth, head, arm, wrist) rather than the reference's simpler head/arms/torso grouping. Two possibilities to test once hardware is available: (a) Lily's firmware maps these 5 physical points onto the same coarse `AACA` bitfield values (e.g. "arms_only" might drive both elbow and wrist together), or (b) her firmware uses additional/different byte values than the reference project's validated set. **Use `probeMovementValues()`/`cmdProbeMovement()` (`lily/protocol.js`, ported from the reference's `probe_movement_value`) to systematically test unused bitfield values (0x08–0xF8, step 8) against real Lily hardware and map out which values actually move which physical points**, rather than assuming the Ultra Skelly enum names apply as-is.

### 2.1.7 Connection sequence (CRITICAL — follow this order exactly)

1. Scan for device (by known MAC address if saved, else by name filter).
2. Connect via BLE.
3. **Verify the `ae00` service is actually present** on the connected device — if not, disconnect and treat as connection failure. (Guards against connecting to an unrelated BLE device.)
4. Subscribe to notifications on `ae02` (notify characteristic).
5. Send `queryVersion()` and wait briefly (~2s) for a reply — but **treat a missing/timed-out version reply as non-fatal**. Firmware version is nice-to-have metadata, not a connection requirement.
6. Mark connected. Movement stays **disarmed** by default (see 2.1.8).

### 2.1.8 Safety interlock — port this exactly

- Add an explicit `armMovement(enabled)` call, separate from `setMovement()`.
- `setMovement()` must **reject** any non-"none" movement command if not armed, with a clear error (e.g. "Movement is disarmed — arm motors first").
- On disconnect (including unexpected drops), **force movement to disarmed and movement state to "none"** immediately.
- `armMovement(false)` should also send `setMovement(0)` (stop) as it disarms.
- This is a cheap, high-value safety pattern for a crowd-facing prop — implement it exactly as described, don't skip it to save time.

*(🔧 The interlock contract is already encoded in `lily/mockLily.js` — the real adapter must match it.)*

### 2.1.9 Auto-reconnect (NOT found in source — build this ourselves)

The reference project has no reconnect loop in its BLE layer. For a centerpiece character running unattended for hours, add:
- A disconnect handler that attempts reconnection on a backoff schedule (e.g. retry every 5s, capped).
- Log/surface disconnect events to whatever haunt-ctrl uses for status/health monitoring.
- Re-arm movement only after a full successful reconnect + service verification (never assume prior arm state survives a reconnect).

---

## 2.2 Audio (Linux-only — Classic Bluetooth + system audio routing)

🔧 *Implemented pre-hardware in `lily/audioRouter.linux.js` (behind the OS-swappable `lily/audioRouter.js` interface, Windows stub for the laptop): bredr scan, pair/trust with stale-pairing recovery on the failure markers below, 60s sink-publish patience loop, `wpctl set-default` + unity gain, 92 Hz/−45 dBFS/0.65 s wake-tone prepend. NOT yet validated on the OptiPlex.*

**Important finding:** there is no custom Bluetooth audio streaming protocol to implement. "Classic BT audio" for this prop family is just **standard OS-level Bluetooth pairing + system audio output routing**. The GATT `setClassicAudio()` command above just tells the prop's onboard firmware to open its Classic BT audio receiver — the actual pairing/streaming is handled entirely by the OS Bluetooth/audio stack, not by any custom code.

### 2.2.1 Tools needed (Linux)
- `bluetoothctl` (BlueZ) — scan, pair, trust, connect, disconnect, remove.
- `wpctl` (PipeWire/WirePlumber) — find the newly-connected device as an audio sink, set it as default output, set volume.

Shell out to these from Node (`child_process`), same approach as the Python reference (which shells out to the same two CLI tools — nothing Python-specific to port here, just the *sequence of calls*).

### 2.2.2 Device identification
The reference project's prop advertises its Classic BT audio endpoint as `Skelly(Live)`. **Confirm Lily's actual advertised Classic BT name via a live scan** (`bluetoothctl --timeout 12 scan bredr`) before hardcoding a name filter — it's very likely a variant naming pattern but should be verified, not assumed.

### 2.2.3 Pairing flow (first-time setup)
1. `bluetoothctl` scan (bredr / classic scan) to discover the device by name filter.
2. If not already paired: `bluetoothctl --agent KeyboardOnly pair <address>`, feeding the PIN.
3. `bluetoothctl trust <address>`.
4. Verify paired via `bluetoothctl info <address>`.

### 2.2.4 Connect + route flow (every session)
1. `bluetoothctl connect <address>`.
2. Poll `wpctl status` for the new sink to appear — **be patient**: on a fresh boot this can take up to ~60 seconds after BlueZ reports "connected" before PipeWire actually publishes the A2DP sink. Poll every ~0.5s, don't fail fast (reference project polls up to 120 times = 60s before giving up).
3. Once the sink appears, `wpctl set-default <sink_id>`.
4. Set sink volume to **unity gain (1.0 / 100%)** — the prop's onboard jaw movement appears to be **audio-reactive to loudness through its own speaker, not a separate GATT command**. Setting a properly loud line level may be what drives jaw movement at all. **This needs to be verified on real hardware once Linux + Lily are both up** — don't assume, test it directly by playing loud audio through the paired connection and watching whether her jaw moves without any explicit "jaw" command sent.

### 2.2.5 Stale pairing recovery (edge case, worth building preemptively)
If a physical factory reset or re-pair invalidates the stored Bluetooth link key, BlueZ can still hold a stale device record. Detect by checking pairing failure output for markers like `authentication canceled`, `authentication failed`, or `connection attempt failed`. On match:
1. `bluetoothctl remove <address>`
2. Wait ~1s
3. Rescan (`--timeout 12 scan bredr`)
4. Retry pairing with the factory PIN once, clean.

### 2.2.6 Audio content approach — decide before building
Two options, given the radio-coexistence risk with BLE+Classic BT on a single ESP32 radio (flagged earlier in planning):
- **(a) Pre-rendered file playback:** TTS renders to a WAV file, uploaded/played via the BLE `playMediaFile()` command (stored-file approach) — avoids any live-streaming/dual-radio contention entirely, at the cost of a small render+transfer delay per line.
- **(b) True live streaming:** Pipe TTS PCM output directly to the paired BT speaker as system audio (e.g. via a Linux audio player subprocess — likely `ffplay`, matching the ffmpeg stack already validated in Part 1), same as the reference project's approach — but only over a **direct Classic BT pairing from the OptiPlex**, not through the ESP32 radio (per our earlier decision to avoid BLE+Classic-BT coexistence issues on the same chip).

**Recommendation: go with (b), OptiPlex-direct Classic BT pairing**, consistent with our earlier architecture decision. This sidesteps the ESP32 dual-radio problem entirely since the OptiPlex handles Classic BT audio independently of the ESP32's BLE GATT link, and reuses the same ffplay/ffmpeg pipeline the rest of the show already relies on.

### 2.2.7 Quiet "wake" tone — prevents clipped first word
Bluetooth audio transports can drop/clip the first fraction of a second of audio while the link "wakes up." Fix: prepend a very quiet tone before every spoken line.

- **Frequency:** 92 Hz sine wave
- **Amplitude:** ~-45 dBFS (roughly 0.55% of max sample value) — audible only if you're listening for it, inaudible in practice through the prop speaker
- **Duration:** ~0.65 seconds (tunable)

Prepend this to every TTS output buffer/stream before sending it to playback, regardless of which audio approach (2.2.6a or 2.2.6b) is chosen. *(Implemented via ffmpeg `aevalsrc` in `audioRouter.linux.js` at exactly these parameters.)*

---

## 2.3 Build order (once Linux is confirmed ready AND Part 1's first full show run-through has passed)

1. **BLE module first** (works fine on Windows too, but do final integration testing on Linux): protocol constants, CRC-8, command builders, connection sequence, safety interlock. Unit-test CRC-8 and command framing before touching real hardware. 🔧 *(protocol + tests + mock built; live noble adapter remains)*
2. **Movement + lighting commands**, tested individually against real Lily hardware (arm → single movement → stop, cycle through lantern colors/modes). Skip eye-icon testing entirely — not applicable to Lily.
3. **Classic BT pairing + routing module** (Linux-only): pairing flow, connect+route flow with sink-publish patience loop, stale-pairing recovery. 🔧 *(built, unvalidated)*
4. **Audio content pipeline**: wake-tone prepend + chosen approach (live streaming recommended, see 2.2.6). 🔧 *(built, unvalidated)*
5. **Auto-reconnect** wrapper around the BLE connection (not present in reference project — new work).
6. **Integrate into Witch Agent** (per existing decision — Lily joins Evelina/Lenora's shared agent, no dedicated agent yet) with:
   - Dialogue + movement-cue selection from the small fixed vocabulary
   - Three-state lantern reactions (calm/wary/protective-ward, see 2.1.5) tied to Evelina's spell state and Wrong Storm Anomalies
   - Spell-restart random-chance trigger line ("Enough. Do it again, and do it right this time.")
7. **Second dedicated PIR sensor** for Lily's zone (standard wireless-ESP32-per-sensor pattern, no new architecture — per earlier decision), with presence/departure debouncing layered in per section 2.4 once basic triggering is proven.
8. **Webcam → Claude vision → 3-zone targeting pipeline** — separate track, genuinely new architecture (not present in the reference project — see 2.4), test at trunk-or-treat demo per existing plan.

---

## 2.4 Presence/departure debouncing pattern (from reference project's `perception.py`)

**Note: this pattern is for Lily's PIR-based session logic, NOT camera vision.** The reference project's camera use turned out to be local presence/departure detection only (person/face/motion counts feeding a state machine) — it does **not** pass any image or camera-derived data to the AI responder call; only the speech transcript + conversation history go to the LLM. So this doesn't inform the planned webcam→Claude-vision→3-zone-targeting pipeline (that remains our own architecture, built from scratch, tested at the trunk-or-treat demo). It IS a useful debouncing pattern to reuse for Lily's PIR-triggered conversation sessions:

- **Presence confirmation:** require **2 consecutive "presence" signals** (spaced ~2.5s apart) before starting a conversation session/turn — avoids a single spurious PIR blip triggering a full response cycle.
- **Departure confirmation:** require **4 consecutive "clear" signals** before ending a session — avoids cutting off a stationary visitor who just triggered one missed/quiet reading.
- If audio-driven presence is available and active, it can short-circuit straight to "presence confirmed" (skip the 2-frame wait) — not required for Lily's PIR-only case, but worth keeping in mind if a mic-activity signal is ever added to her triggering logic.
- Practical mapping to haunt-ctrl: treat Lily's dedicated PIR (2.3, item 7) the way this pattern treats a camera-presence signal — 2 consecutive PIR-active polls to start engaging, 4 consecutive PIR-clear polls before considering the visitor gone, rather than a single-read trigger/timeout.

This is a nice-to-have robustness improvement, not a blocker — Lily's PIR can ship with simple single-read triggering first and have this debouncing layered in afterward if false-triggers become a real problem in testing.

---

## 2.5 Additional groundwork Claude Code should do before/alongside the build above

- **Explore the actual repo structure first.** This spec describes what to build, not where — find the current Witch Agent file, Director's dispatch/routing logic, and the Setup/Test tab UI code before writing anything new. Don't guess file names or create parallel structures if equivalent files already exist. *(Status 2026-09: no Witch Agent or Director exists in code yet — the multi-agent architecture is documented in `CHARACTER_BIBLE.multiAgentArchitecture` and its support structures exist, but the agents themselves are unbuilt. Lily's Witch Agent integration therefore lands WITH the conductor build.)*
- **Build a simulated/mock Lily adapter** ✅ *(built: `lily/mockLily.js`)*, mirroring the reference project's own `SimulatedSkelly` pattern — a fake BLE/audio module returning realistic responses (connected/disconnected state, fake snapshots, etc.). This lets the connection logic, safety interlock, and lantern-state logic be built and unit-tested *before* real hardware is available.
- **Add a "Lily enabled" config flag for graceful degradation.** ✅ *(built: `settings.lilyEnabled`, default false.)* If her BLE or Bluetooth audio isn't working reliably on show night, the rest of the show (Evelina/Lenora/Jasper/Edgar) must not go down with her. The Director and Witch Agent should skip her cleanly when disabled or unreachable, not treat her connection as a hard dependency for the whole show.
- **Verify `@abandonware/noble` works against the target Linux + BlueZ early** 🔧 *(compile/install smoke test passed on Node 22/Linux 2026-09; live BlueZ runtime test pending on the OptiPlex — see 2.0.)*

---

## 2.6 Open items to verify on real hardware (Linux + Lily both present)

- [ ] Confirm Lily's actual advertised BLE device name and Classic BT audio device name via live scan (don't assume `Skelly(Live)`-style naming carries over exactly).
- [ ] Confirm whether jaw movement is truly audio-reactive-only (no GATT jaw command exists in the source protocol) — test by playing loud audio through her paired speaker with no movement commands sent.
- [ ] Test BLE + Classic BT radio coexistence in practice (this should be moot if Classic BT audio runs OptiPlex-direct per 2.2.6 recommendation, but confirm no interference with the ESP32's BLE link regardless).
- [ ] Confirm CRC-8 implementation against real commands/real acknowledgement behavior (unit tests pass the CRC-8/MAXIM check value 0xA1; the padding direction in `buildCommand` — trailing vs leading zeros — must be confirmed against a real acknowledged command).
- [ ] Determine real lantern RGB/mode values for the three mood states (calm / wary / protective-ward, section 2.1.5) — test visually. Eye icons are NOT applicable to Lily.
- [ ] **Map Lily's 5 independent servo points (eyes, mouth, head, left arm/elbow, left hand/wrist) onto real BLE command byte values** using `probeMovementValues()`/`cmdProbeMovement()` against real hardware — her granular servo layout doesn't map cleanly onto the Ultra Skelly reference's coarse movement enum, so this needs to be reverse-engineered rather than assumed. Right arm is presumed static/non-articulated; confirm this holds once unboxed.
- [ ] Validate the ffmpeg `aevalsrc` wake-tone generation and the first-word-clipping fix audibly through Lily's speaker.
- [ ] First-time PIN pairing: one-shot `bluetoothctl pair` cannot feed a PIN — do the very first pair interactively on the OptiPlex (`bluetoothctl --agent KeyboardOnly`), after which the stored link key makes every scripted connect work.

---

*Part 2 source reference: TheDadTech/UltraSkellyAdvanced (github.com/TheDadTech/UltraSkellyAdvanced), files reviewed: `ble.py`, `ble_protocol.py`, `hardware.py`, `speech.py`, `classic_audio.py`, `operation_settings.py`, `perception.py`. Reimplemented conceptually for Node.js/haunt-ctrl — no code copied verbatim.*
