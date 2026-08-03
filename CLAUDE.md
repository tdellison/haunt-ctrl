# HAUNT CTRL v3 — Project Memory

Halloween AV show controller for Todd (tdellison13@gmail.com). Node.js server on a Dell laptop at `C:\Users\tdell\haunt-ctrl-v3\`, controlled from iPhone at `http://192.168.1.168:3000`.

## Workflow (IMPORTANT)
- **Make all changes directly to files. Never output code to chat. Never ask the user to copy/paste.**
- Owner starts everything by double-clicking `start-haunt-ctrl.bat` (desktop shortcut "Haunt Ctrl"): it does `git fetch` + `git reset --hard origin/master`, auto-generates test voices if missing, then runs `node server.js`.
- Deliver every change by committing and pushing to **master**. The Dell picks it up on next bat launch.
- Owner has granted standing permission for GitHub pushes without asking.
- `node_modules` is COMMITTED to the repo on purpose (the Dell must never need npm install). Do not gitignore it.
- `govee-slots.json` and `show-state.json` are per-machine runtime files, gitignored.
- Always run `node --check server.js` before committing.
- **Delivery workflow (owner preference): PowerShell on the Dell.** Cloud sessions frequently lose their GitHub push credential mid-session (403 on `git push`, unrecoverable inside that session). Do not burn time retrying or spinning up fresh sessions. Instead: for a one-line change, hand the owner a single PowerShell block using (Get-Content $p -Raw).Replace(...) that edits, syntax-checks, commits and pushes. For larger changes, send the changed files and have the owner download (NOT drag - dragging creates 1KB shortcuts), copy into place, then commit and push from PowerShell. Always back up the originals first and verify byte counts before committing.
- Commit as `Claude <noreply@anthropic.com>`.

## Hardware
- **Receiver**: Onkyo TX-NR838, ISCP over TCP at `192.168.1.161:60128` (DHCP-reserved, MAC 00:09:b0:9b:de:c3). Zone volume 0–80 hex. A command queue (`queueISCP`) serializes traffic.
- **Govee IPs**: known DHCP reservations live in `DEFAULT_SLOT_IPS` in server.js (skeleton = 192.168.1.216) so they survive a fresh setup; anything saved in Test → System overrides them (persists to govee-slots.json). Network has flipped subnets a few times (.1.x → .68.x → back to .1.x) — always confirm from the router's device list before trusting a saved value.
- **Fog machine**: fired via receiver 12V trigger commands (`TGA01`/`TGA00`), 4-min warmup. Auto-timer exists but stays OFF during the show — **fog is 100% conductor-controlled** via `POST /api/fog/fire {duration}`; heavy on major spells/Overhead, none during downtime. Strategy + constraints in `CHARACTER_BIBLE.fogStrategy`. RISK-9 hard caps enforced in code: min 45s between bursts, max 20s per burst (`state.fogCooldownUntil`). Weather-aware timing was REMOVED (projections gone; owner sets machine level by hand).
- **Playback**: VLC command line (`C:\Program Files\VideoLAN\VLC\vlc.exe`), audio clips `--intf dummy --play-and-exit --no-loop --no-repeat --no-video`.
- **Lights**: Govee LAN API (UDP 4003 send / 4002 listen / 4001 scan). Each zone is a tethered pair on ONE controller IP.
- **Displays**: Laptop + 2 projectors (DP→HDMI) + receiver HDMI (shows as a 4th phantom display named ONKYO — normal).

## Zones (final layout)
- **Zone 1 (z1/MVL) — SKELETONS**: Front L/R + Center terminals. **Jasper = left skeleton = FL speaker, Edgar = right = FR**, center between them. Skeletons ~7–8 ft apart, tucked into island trees. One is white (Edgar), one brown/rotting (Jasper). Jasper gets a passive mic later.
- **Zone 2 (z2/ZVL) — GRAVEYARD**: ambient bed + AtmosFX projection audio ducking.
- **Zone 3 (z3/Z3L) — WITCHES**: RCA pre-out to class-D amp. **Evelina (main witch) = LEFT RCA** (future mic-reactive), **Lenora (witch 2) = RIGHT**.
- Witch fire ducks z1 by 8 for 30s (skeletons 22 ft from witch mic — bleed).
- Sound presets: normal (30/28/26) / boost (40/38/36); storm volumes are locked and never affected.

## Govee light slots (8, one IP each, persisted in govee-slots.json)
**6 floods + 2 A19 bulbs. The storm-tracker slot was REMOVED entirely** — storm stages now drive the monument bulb.

| # | Slot key | Fixture | Behavior |
|---|---|---|---|
| 1 | `skeletonLeft` | flood | fire illusion, orange/red irregular flicker (192.168.1.216) |
| 2 | `skeletonRight` | flood | fire illusion, orange/red irregular flicker |
| 3 | `witchMain` | flood | deep purple breathing pulse (192.168.1.209) |
| 4 | `witchSecond` | flood | deep purple breathing pulse |
| 5 | `moonLeft` | flood | cool blue steady, never changes |
| 6 | `moonRight` | flood | cool blue steady, never changes |
| 7 | `cauldron` | A19 bulb | green organic flicker, spell-reactive |
| 8 | `monument` | A19 bulb | spectral progression tracking storm stages |

- **`SLOT_GROUPS` aliases**: `getSlotIds('skeleton'/'witch'/'moon')` expands to both members of the pair, so behaviors address a pair while IPs stay per-fixture.
- **Monument progression** (`MONUMENT_STAGES`, `monumentTick`): Stage 1 completely OFF → 2 barely visible cold white-grey → 3 dim blue-green spectral → 4 brighter green-teal pulsing → 5 full spectral green-blue cycling (Grand Ritual). It emerges, it does not flicker.
- **Spectral laugh** fires from the graveyard speakers at 75% through the Grand Ritual build, as the monument reaches maximum, just before the overhead blast.
- **Anomaly hooks**: `setMonumentOverride(stageIdx|null)` drives the monument independently of the storm stage (wrong-storm anomaly = go spectral before the incantation). `setMonumentBlackout(true/false)` holds it at a bare ember so it's the last light dark and the first back after the blast. **Both are built but not yet wired to storm variants** — the wrong-storm and blackout-storm anomalies don't exist in the storm engine yet.
- **Overhead strike**: all 8 slots flash full white simultaneously, then every light returns to its base/effect.

### Previous 5-slot layout (superseded)
| Slot | Base | Behavior |
|---|---|---|
| skeleton | orange/red fire {255,80,0} 25% | FIRE ILLUSION loop: 5-color palette, random 250–1400ms, flares & smolders; brightens 45–65 while either skeleton talks |
| witch | deep purple {100,0,180} 30% | slow ~8s breathing pulse 18–42 |
| moon | cool blue {60,120,255} 40% | steady all night, never changes |
| storm | cold blue {30,120,255} 15% | tracks storm stages: 15/30/50/75% → Overhead |
| cauldron | green {0,180,0} 60% | organic rolling-boil flicker; spell = builds then deep red pulse 20s then back to green; NO white during spells |
- **Overhead strike**: ALL slots (cauldron included) flash full white 600ms, then every light returns to its base/effect. Fallback: if no slots assigned, flashes all discovered devices.
- Effects engine (`/api/effects/toggle`, auto-starts with `applyShowScheme`); stopped by allstop/shutdown/strikedown.
- Tombstone lights are separate bluetooth units, static hellish red/orange, set by hand — NOT server-controlled.

## Storm engine
5-stage progressive cycle, 2-min intervals, auto-repeats: Distant → Getting Closer → Close → Very Close → Overhead. Random clip from `STORM_FILES` for stages 1–4; **Overhead always plays `646912__alexdarek__lightning-strike-2.wav`** (never randomized). Overhead also fires fog burst. Manual controls live in the Test tab (FIRE STRIKE NOW, per-stage light tests, per-clip audio tests).

## Media folders (Desktop, OneDrive)
`storm`, `graveyard ambient`, `WITCH`, `SKELETON`, `Haunt sounds` (overlay FX — phantom map matches filenames by keyword: crow, owl, wolf, chain, wind, demon, scream). **Projections: REMOVED — the projector is not used this year.** All AtmosFX code (routes, VLC process, Test-tab panel) was deleted; if projections return a future year, rebuild from git history (`side of the house` folder concept, display 4, z2 ducking). Skeleton test files: `skeleton-left.wav`/`skeleton-right.wav` (stereo, hard-panned). Witch: `witch-main-left.wav`/`witch2-right.wav`. `make-skeleton-voices.ps1` generates them via Windows TTS. JACKOLANTERN and LEGENDS ATMOS folders are orphaned (jamboree + character systems removed) — owner may delete.

## Characters & spells
Show identity: **The Hollow Storm** at **Thornfield Cemetery, Est. 1724** — cemetery predates the ritual by decades; built/managed by the Thorn family before Evelina arrived (Lenora's family connection is never explicitly stated — lore for those who notice). Crypt prop carved "Thornfield Cemetery Est. 1724". Evelina references Thornfield casually, Lenora with personal weight.
Story: **The Hollow Storm** — 300 years ago witches Evelina Crowe and Lenora Thorn tried to harness it; the ritual failed, they became bound to it, the dead rose (Jasper and Edgar were caught in the disaster). Every Halloween the storm returns, Evelina tries to complete the ritual, Lenora warns her not to; guests are caught in the middle. Nobody knows what the storm is (Evelina: power to harness; Lenora: living force, uncontrollable; Jasper: it's watching everyone; Edgar: everyone's overreacting) — the mystery is intentional.
- **Evelina Crowe** — main witch (z3 LEFT, mic): curious, charming, overconfident; drives the action; genuinely likes guests.
- **Lenora Thorn** — second witch (z3 RIGHT): wise, dry, patient; warns and provides lore; "I know."
- **Jasper Bones** — left skeleton (z1 FL, passive mic later): nervous, superstitious; notices every effect first; builds suspense.
- **Edgar Rattle** — right skeleton (z1 FR): sarcastic, lazy comedy relief; denies ever being worried; arc = indifference erodes as storm builds, never admits it.
Grand Ritual ends the night: Lenora "Well?" / Evelina "Almost." / Jasper "We're doomed." / Edgar "See everyone next Halloween."
- **Storm CYCLES repeat all night** (~10-15 min each, Distant→Grand Ritual→reset; each cycle freshly generated by Claude, never identical; quiet-cycle mode runs shorter/faster when sensors are idle).
- **~5.5-hour show window** with time-of-day escalation (daylight playful → full-dark building → peak → Grand Ritual → wind-down); Claude tracks elapsed time automatically.
- **Edgar extra AI-phase behaviors**: quiet-period boredom callouts (after 3-4 min sensor inactivity, Edgar only), neighbor sing-along, and a comedy-with-depth arc (dark humor as coping, jokes fade as Stage 5 nears).
- **Proactive dialogue windows** (REPLACED reactive interruption handling): streamed TTS can't be cleanly interrupted, so Evelina deliberately opens the mic between audio blocks with an invite line ("Tell me something true. The storm feeds on truth."). Mic is ONLY open during those windows — eliminates mid-stream interruption risk entirely. Full detail in CHARACTER_BIBLE.

Spells (3s green build → spell window → back to green boil, NO white ever on the cauldron), tiered:
- **MINOR** (cauldron only, frequent): Spell of Binding — deep blue pulse {0,40,200}; Spell of Calling — amber/gold flash {255,170,0}
- **MAJOR** (full-yard lighting via `effects.spellYard`, max 1–2/hour): Spell of Unraveling — cauldron green↔purple cycle + witch lights go deep green pulse, skeleton fire faster/erratic, moon dims to ~28, snap back after 20s; Spell of Memory — cauldron+witch deep crimson {150,0,30}, skeleton fire near-out (4–10 bri), moon untouched, 30s window then SLOW 3-step fade back (never a snap)
- **GRAND RITUAL** (once at end of night): full-yard build — storm slot electric blue→white, skeleton fire max, witch rapid purple↔bright alternation, cauldron all-colors cycle — into the Overhead white blast → applyShowScheme restore → final exchange. NEVER random, explicit only (Overhead/AI)

`/api/witch/fire` takes optional `spell`; otherwise picks a random spell (never grandritual, never same twice; majors rate-limited via `lastMajorAt` — enforced in code, 30-min spacing, minors only otherwise). AI-conductor-phase behaviors documented in the bible: neighbor music detection (mic; z2/z3 volume bump max 1/30min, character quips 1-in-5 with 10–15min cooldown), ambient sound acknowledgments (1-in-3/4 of sounds get an in-character reaction, per-sound lines in bible), off-script callouts (host context worked examples + rules in bible). `POST /api/spell/test {spell}` = lights only. Full `CHARACTER_BIBLE` lives in server.js, served at `GET /api/character-bible` for the AI conductor. **Translation Matrix** (bible): every host input is a Warden signal — never echoed raw, always translated in-character; includes latency masking (characters telegraph an incoming Warden signal while a Sonnet call is in flight) and a crowd-control category that takes priority. **Host context field** on the SHOW tab (`POST/GET /api/context`, 200 chars): host notes about current guests; expires after one interaction — enforcement in the AI conductor phase (`markContextUsed()`).

## UI (public/index.html)
Three tabs: **SHOW** (minimal: zone level tiles, Normal/Boost, pause, ALL STOP, STRIKE DOWN, health row, log), **🧪 TEST** (everything else; panels are collapsible — start folded, tap title), **SETUP**. Strike Down = teardown mode: stops everything but turns all lights warm white so owner can pack up in the dark.

## Yard (surveyed, see yard_layout.json)
57 ft frontage × 44 ft deep corner lot. Witch at front-left corner (4,6); skeleton/host table zone at garage front (25,4), 22 ft from witch; projector aims at side of house. All Govee floods in graveyard/scene zones.

## October plan (not yet built)
- **ElevenLabs**: owner starting on free tier (static clips, stock voices — leaning Southern-drawl voices for skeleton banter). October: paid tier + `/api/witch/speak` becomes real (placeholder route exists, needs ELEVENLABS_API_KEY). Recommended: ElevenLabs Agents for the witch conversation loop with tool calls into this server's API.
- **Mic** for reactive main witch (hardware TBD).
- **PIR/ESP32 sensors**: owner HAS 5 PIR sensors + 2 ESP32s. Plan: ONE ESP32 handles the 3 show PIRs (witch approach, skeleton/driveway approach, mid-graveyard; other 2 PIRs are spares), on WiFi POSTing to `/api/sensor/trigger` (simulation route + Test tab panel already exist). The 2nd ESP32 is RESERVED — owner has a future update in mind for it; do not assign it. Firmware sketch + real per-zone trigger logic still to build.
- **AI conductor**: Claude runs the whole show via the existing API routes; indoor test planned first.
- Owner will report dialed-in brightness values after outdoor testing → lock into SLOT_BASES.
- Smart plugs: DROPPED — owner controls them via their own app (background fire glow or other colors), not server-controlled.

## Phase 2 additions (built)
- **Voice input on Host Context**: 🎤 button beside SEND on the SHOW tab, Web Speech API (Chrome/Safari only — button hidden + note shown when unsupported). Tap to record (button turns red), transcript fills the field live, tap again or 3s silence auto-sends via the existing `/api/context` path.
- **One-tap Show Start** (`POST /api/show/start`): fog warmup → applyShowScheme + effects → ambient → sensors armed (`state.sensorsArmed`) → storm cycle reset to Distant → `state.showActive`/`state.showStartedAt` set (elapsed tracking). `POST /api/show/stop` marks inactive + stops storm cycle (NOT a teardown — that's ALL STOP/STRIKE DOWN). SHOW tab has a green ▶ START SHOW button that flips to red ■ END SHOW with a live elapsed readout.
- **Lenora is a STATIC PROP** — voice only, no physical movement, never raises her voice (`characters.lenora.staging` in CHARACTER_BIBLE).
- Onkyo receiver reserved at **192.168.1.161**; Dell reserved at **192.168.1.168**. Govee light IPs still need entering in Test → System.

## Phase 2 hardening
- **Govee UDP queue**: per-IP outbound queue, 50ms min gap, priority 0 storm flash / 1 spell+calm+Edgar / 2 flicker loops (default). `goveeSend(ip, cmd, priority)` still returns a Promise.
- **VLC watchdog**: 5s interval restarts the ambient loop if `ambientShouldRun` but the process died. `vlcHealth.ambientRunning` in state.
- **Sensor priority queue**: witch > skeleton > graveyard; simultaneous trips fire the top zone now, others 3s apart. All `/api/sensor/trigger` calls route through it.
- **ESP32 heartbeat**: `POST /api/sensor/heartbeat`; offline after 3 missed beats (>30s). **Quiet mode requires `esp32.online`** — a dead board looks identical to an empty yard.
- **Cycle drift stats**: `state.cycleStats` (cyclesCompleted / lastCycleMs / avgCycleMs) recorded on each Overhead→Distant wrap; conductor uses it to hit the ~9pm Grand Ritual.
- **Model router**: `getModel(type)` — Haiku for routine orchestration, Sonnet for anything spoken to a guest (guest_interaction / grand_ritual / edgar_reset / host_context). `GET /api/model?type=`.
- **Token budget**: $9.00 nightly cap, 4 modes (full / haiku_only / cached_preferred / cached_only), `GET /api/budget`, `POST /api/budget/track`, `POST /api/budget/reset`; readout in the SHOW tab health row.
- **Extensible CHARACTERS array** (`GET /api/characters`): zone/channel/mic/static/voiceId. Add a 5th character with one entry + a bible entry.
- **Calm phase** (`POST /api/calm`, Test→Lights "🌫 CALM PHASE") and **Edgar threshold pulse** (`POST /api/edgar/annoyed`, Test→Skeletons) are manual-fire only until the AI conductor drives them.
- **Interruption handling REPLACED** by `proactiveDialogueWindows` — ElevenLabs streams can't be stopped mid-sentence, so Evelina deliberately opens the mic with a trigger line instead of reacting to talkers. Bible also gained `calmAfterTheStorm`, `warden` (host = The Warden of Thornfield), `neighborMusicDetection.edgarAnnoyanceThreshold`, and `technicalSafeguards`.

## Multi-agent + phantom layer
- **Four agents** (conductor phase, documented in `CHARACTER_BIBLE.multiAgentArchitecture`): **Director** (Haiku — dispatch, lock, heartbeat, Warden routing, never writes dialogue), **Witch** (Evelina/Lenora, dialogue windows, spells), **Skeleton** (Jasper/Edgar, callouts, acks, cross-character), **Graveyard** (ambient, fog, storm clips, VLC).
- **Audio lock** in code (`POST/GET /api/audio/lock`, `POST /api/audio/release`, `audioLock` in stateSnapshot): one output speaks at a time, 7-level priority — grand ritual > guest mic response > Warden signal > cross character > ambient acknowledgment > quiet period callout > atmosphere painting. Force-released after 45s; queue drain broadcasts an `audio_next` event.
- **Director heartbeat** every 30s (Haiku only): sensor idle (3+ min → Edgar callout), storm stage vs elapsed, last ambient, fog gap vs intensity, budget, queue depth. No action is a valid outcome.
- **Grand Ritual protocol**: fog sustained → all lights cycle → Evelina incantation (Sonnet, fresh) → 500ms → overhead white blast + thunder all zones → 800ms silence → Lenora/Evelina/Jasper/Edgar in strict order → thunder crash → calm phase → cycle reset. Director holds the lock throughout; an agent timeout falls back to a cached line — the sequence never stops.
- **Graveyard = atmosphere painter**: swell-then-silence before a major spell, silence as a valid choice after character moments, fog as punctuation, ambient mix shifts on storm-stage transitions.
- **PHANTOM_MAP** (`firePhantom`, `POST /api/phantom/fire`, `GET /api/phantom/map`, Test→Audio buttons): zero-LLM ambient reflexes on storm stages/spells/fog/sensors. 20s minimum gap, respects the audio lock, suppressed during the Grand Ritual, keyword-matched filenames (crow/owl/wolf/wind/chain/demon/scream) so it works as soon as HAUNT SOUNDS is populated.
- **ESP32 local handling**: `/api/sensor/trigger` accepts `{zone, escalate, localHandled:[...]}` (escalate defaults true). `escalate:false` logs and returns without entering the priority queue. `POST /api/sensor/stage` records the storm stage for the board to reflect locally in <50ms. Cuts Claude calls ~40-60%.

## Phase 2 final adds (§27–29, built)
- **Mic gate (§27)**: `muteMics(ms, reason)` / `micsMuted()` / `state.micGate`. Storm clip = 6s assumed + 1s tail, **overhead strike = hard 3s floor**, character audio = 3s (RISK 7). Storm mute **outranks every other mic state** — an overhead strike closes an open dialogue window immediately; a longer mute is never shortened by a later shorter one. Wired into `playStormFile` so every storm clip gates automatically. `GET /api/mic/gate`, `POST /api/mic/mute {ms, reason}`.
- **Voice intrusions (§28)**: `fireIntrusion(kind)` / `intrusionEligible()`. Ghostly or demonic — something drawn in by the storm. **Hard limit of 2 per night**, enforced in code. Only during Close/Very Close, never during Grand Ritual or calm phase, never twice in the same cycle, auto-picks demonic at Very Close. Reaction lines per character in `CHARACTER_BIBLE.voiceIntrusions`. Characters acknowledge it once and never reference it again. `POST /api/intrusion/fire {kind?}` (409 + reason when ineligible), `GET /api/intrusion/status`.
- **Internet failsafe (§29)**: health check every 30s, 2 consecutive failures → `state.net.degraded`. Degraded = cached local audio + rule-based decisions; Whisper, phantom sounds, storm cycling, lights and fog all keep running — the show never fully stops. Timeouts: ElevenLabs 3s, Claude 4s (serve cache, don't wait). Cache dir `cache/audio/`, filenames must start with the character id for the per-character count to work. `GET /api/net/health`, `GET /api/cache/audio`. Host fix for a real outage: phone hotspot.
- Note: **`/api/state` is not a route** — it falls through to index.html. The state snapshot ships over the WebSocket (`{type:'state'}`).

## Known gotchas
- Dell IP was 192.168.1.8, now **192.168.1.168** (bat + docs reference it).
- If site won't load: bat window shows the error above "SERVER STOPPED"; commonest cause historically was missing node_modules (now committed).
- Stop-hook "Unverified commits" warnings are noise when commits are already authored as noreply@anthropic.com and pushed.
- GitHub 403 from a session = that session's credentials died; a fresh session fixes it (owner already reconnected the integration).
- **Phone can't reach the server but the Dell can (SOLVED — Norton).** Symptom: `http://192.168.1.168:3000` loads in Chrome on the Dell, blank/unreachable from the iPhone; `netstat -ano | findstr :3000` shows `0.0.0.0:3000 LISTENING` with no connection from the phone's IP. Cause: Norton 360 Smart Firewall. The fix took all of these:
  1. Windows Firewall inbound rule: `netsh advfirewall firewall add rule name="HAUNT CTRL 3000" dir=in action=allow protocol=TCP localport=3000` (admin prompt).
  2. Norton → Settings → Firewall → Smart Firewall → **Network** tab: set **Sky Net / Sky Net-5G / Sky Net-5G 2** to **Private** (they defaulted to Public).
  3. Norton → **Traffic Rules** tab: new rule `Haunt ctrl 3000` — Allow / In / TCP / Address `192.168.1.0-192.168.1.255` (CIDR `/24` is rejected; use the dash range) / local port 3000 / Reporting None.
  4. **CRITICAL: drag that rule to the TOP of the Traffic Rules list.** Norton matches top-down and stops at the first hit; new rules land at the bottom under the default block rules and never fire. Steps 1–3 alone did nothing — the reorder is what fixed it.
  - Norton Program Control already had Node.js on Allow, so that layer was never the problem.
  - Norton VPN adapters are installed on the Dell. They were disconnected during the show setup. If that VPN ever auto-connects it will reroute traffic and break both the phone UI and Govee UDP discovery — disable auto-connect before show night.
- iOS Safari will send `192.168.1.168:3000` to Google search; type the full `http://192.168.1.168:3000`. Bookmark it to avoid the issue entirely.
