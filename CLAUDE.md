# HAUNT CTRL v3 — Project Memory

Halloween AV show controller for Todd (tdellison13@gmail.com). Node.js server on a Dell laptop at `C:\Users\tdell\haunt-ctrl-v3\`, controlled from iPhone at `http://192.168.1.11:3000`.

## Workflow (IMPORTANT)
- **Make all changes directly to files. Never output code to chat. Never ask the user to copy/paste.**
- Owner starts everything by double-clicking `start-haunt-ctrl.bat` (desktop shortcut "Haunt Ctrl"): it does `git fetch` + `git reset --hard origin/master`, auto-generates test voices if missing, then runs `node server.js`.
- Deliver every change by committing and pushing to **master**. The Dell picks it up on next bat launch.
- Owner has granted standing permission for GitHub pushes without asking.
- `node_modules` is COMMITTED to the repo on purpose (the Dell must never need npm install). Do not gitignore it.
- `govee-slots.json` and `show-state.json` are per-machine runtime files, gitignored.
- Always run `node --check server.js` before committing.
- Commit as `Claude <noreply@anthropic.com>`.

## Hardware
- **Receiver**: Onkyo TX-NR838, ISCP over TCP at `192.168.1.190:60128`. Zone volume 0–80 hex. A command queue (`queueISCP`) serializes traffic.
- **Fog machine**: fired via receiver 12V trigger commands (`TGA01`/`TGA00`), 4-min warmup, auto-timer exists.
- **Playback**: VLC command line (`C:\Program Files\VideoLAN\VLC\vlc.exe`), audio clips `--intf dummy --play-and-exit --no-loop --no-repeat --no-video`.
- **Lights**: Govee LAN API (UDP 4003 send / 4002 listen / 4001 scan). Each zone is a tethered pair on ONE controller IP.
- **Displays**: Laptop + 2 projectors (DP→HDMI) + receiver HDMI (shows as a 4th phantom display named ONKYO — normal).

## Zones (final layout)
- **Zone 1 (z1/MVL) — SKELETONS**: Front L/R + Center terminals. Left skeleton = FL speaker, right = FR, center between them. Skeletons ~7–8 ft apart, tucked into island trees. One is white, one brown/rotting.
- **Zone 2 (z2/ZVL) — GRAVEYARD**: ambient bed + AtmosFX projection audio ducking.
- **Zone 3 (z3/Z3L) — WITCHES**: RCA pre-out to class-D amp. **Main witch = LEFT RCA** (future mic-reactive), witch 2 = RIGHT.
- Witch fire ducks z1 by 8 for 30s (skeletons 22 ft from witch mic — bleed).
- Sound presets: normal (30/28/26) / boost (40/38/36); storm volumes are locked and never affected.

## Govee light slots (5, one IP each, persisted in govee-slots.json)
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
`storm`, `graveyard ambient`, `WITCH`, `SKELETON`, `ATMOSFX` (files coming), `HAUNT SOUNDS` (overlay FX). Show-night projection clips live ONLY in `ATMOSFX\side of the house\` — `/api/atmosfx/random` picks randomly from that subfolder (no back-to-back repeats); this is the route the AI conductor uses for projections. Skeleton test files: `skeleton-left.wav`/`skeleton-right.wav` (stereo, hard-panned). Witch: `witch-main-left.wav`/`witch2-right.wav`. `make-skeleton-voices.ps1` generates them via Windows TTS. JACKOLANTERN and LEGENDS ATMOS folders are orphaned (jamboree + character systems removed) — owner may delete.

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

## Known gotchas
- Dell IP was 192.168.1.8, now **192.168.1.11** (bat + docs reference it).
- If site won't load: bat window shows the error above "SERVER STOPPED"; commonest cause historically was missing node_modules (now committed).
- Stop-hook "Unverified commits" warnings are noise when commits are already authored as noreply@anthropic.com and pushed.
- GitHub 403 from a session = that session's credentials died; a fresh session fixes it (owner already reconnected the integration).
