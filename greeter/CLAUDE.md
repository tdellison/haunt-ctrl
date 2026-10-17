# LILY DOOR GREETER — Project Memory

Lethal Lily (an animatronic skeleton with a lantern) greeting visitors at the door of Todd's
workplace (tdellison13@gmail.com). Runs on a Linux PC next to her, wired network. Setup page:
`http://<this-machine>:3100` (phone or browser). Born as a spin-off of Todd's Halloween show
"haunt-ctrl" (that repo's `lily/` folder is copied in here) — this app has NONE of the show.

## Workflow (IMPORTANT)
- Make changes directly in files; never ask Todd to copy/paste code.
- After editing: `node --check` every changed .js file, then `systemctl --user restart lily-greeter`
  and watch `journalctl --user -u lily-greeter -f` (or the log on the setup page).
- This folder is a local git repo (setup-linux.sh makes it) — commit each working change as
  `Claude <noreply@anthropic.com>` so it can be rolled back. There is NO GitHub remote, on purpose:
  Todd found GitHub pushes from Claude sessions unreliable and a token sink. Don't add one unless asked.
- `node_modules` is shipped in the folder — never needs `npm install`.
- Per-machine files (never delete without asking): `greeter/greeter-config.json` (settings),
  `greeter/lily-config.json` (her addresses), `greeter/secrets.json` (Anthropic + ElevenLabs keys,
  mode 600), `greeter/cache/` (voiced lines), `greeter/team/` (staff photos), `greeter/.venv/` +
  `greeter/models/` (face recognition, made by setup).

## Layout
- `greeter/server.js` — Express on port 3100 (`GREETER_PORT`), config defaults (`DEFAULTS`), all routes, boot autostart (camera, mic, Lily BLE + speaker reconnect).
- `greeter/camera.js` — ONE ffmpeg owns the webcam (`/dev/video*`, v4l2): pipe 1 = 160×120 grey frames for motion (adaptive background, motion % inside a drawn box → "arrival"); pipe 3 = 4 fps 640-wide JPEGs for faces + the setup page picture. A second process can't open the webcam — reuse these pipes.
- `greeter/chime.js` — the mic (ffmpeg `-f pulse`, 16 kHz mono). LEARN CHIME = FFT of the loudest moment → up to 3 tones; listening = Goertzel energy at those tones vs total. Also forwards raw audio to converse.js (one mic stream for both).
- `greeter/greeter.js` — the decisions: cooldown (20 s), greeting hours, team pause, chime-as-backup, team recognition flow, outfit remarks, line picking, ElevenLabs line cache, playback (her speaker → else computer speaker → else her built-in phrase).
- `greeter/converse.js` — after a greeting the mic opens 15 s: energy VAD → whisper.cpp (`~/whisper.cpp`, ggml-base.en, whisper-server on 8178) → Claude `claude-haiku-4-5` (work-greeter persona + Todd's "office notes", JSON output) → ElevenLabs → her speaker. Each reply re-opens the window; outside it she ignores the room.
- `greeter/faces.js` + `greeter/faces.py` — team recognition: Python helper (OpenCV YuNet detect + SFace 128-d fingerprint, cosine ≥ `faces.threshold` 0.4) over stdin/stdout JSON lines. Photos `greeter/team/<Name>/*.jpg`, LOCAL ONLY.
- `greeter/outfit.js` — optional: one camera frame → Claude Haiku → a kind remark about clothes. OFF by default; the only feature that sends a picture off the machine.
- `greeter/public/index.html` — the setup page (polls `/api/status` every 1 s).
- `greeter/public/phone.html` — phone page at `/phone`: online status + type a name / line and she says it now (`POST /api/say {text}` → `greeter.say`, ignores hours/cooldown, never falls back to a built-in clip). Recent names kept in the phone's localStorage.
- `lily/` — her drivers (shared with haunt-ctrl): `index.js` createLily (BLE + audio + config), `bleLily.js` (BlueZ D-Bus via node-ble), `audioRouter.linux.js` (bluetoothctl/wpctl, the ONLY file allowed to call them), `protocol.js` (+ `node lily/protocol.test.js`), `mockLily.js`, `talk.js` (the haunt's conversation code — the greeter imports only `elevenTts`, `transcribe`, `rms`, `TONES` from it).
- `voices.json` — ElevenLabs voice ids; `lily` = hOhoyLFaNbOOWbbcSfDn (her designed voice). The greeter's voice is `voiceId` in greeter-config.json (setup page → Her voice), defaulting to `GREETER_VOICE` = 6xNonY5CNANKZ87uLcCK (Todd's greeter-only voice) — never edit voices.json for the greeter.
- `greeter/setup-linux.sh` (one-time machine setup + systemd user service `lily-greeter`), `greeter/make-usb-bundle.sh` (packs this folder).

## Behaviour (as Todd asked for it)
- Camera = main trigger. Door chime = backup only: greets if the camera saw nothing within 15 s ("if the camera doesn't pick anything up, she can say hello").
- Team recognition ON by default (inert until photos added). Camera fires → she looks ~2 s:
  stranger's face → greeting (also when a teammate is with them); only teammates → `teamLines` remark
  by name ("Oh, it's just you, Todd. You may go now."), max once per person per hour, else silent;
  no face (back turned = leaving) → silent, and the chime is ignored for that door opening.
- Small space — staff come and go a lot; Todd was going to confirm with work that staff photos are OK.
- Outfit remarks: strangers only, `outfit.chance` (35%) of the time, written while the cached greeting plays, said after it or dropped after 4 s. Clothing only — never faces/bodies/age.
- Persona: warm and welcoming first, dry gently-spooky wit second, workplace-appropriate; never invents facts beyond the office notes; can't call anyone or open doors.

## Lily hardware facts (verified on the real prop, Oct 2026 — trust these over any older doc)
- BLE body "Lethal Lily" 1A:74:89:6F:37:DB; Classic BT speaker "Lethal Lily(Live)" 1A:74:89:F2:ED:95 (separate address; only appears after live mode `AAFD01` is sent over BLE — `audioConnect` does that). Pairs with no PIN.
- BLE write characteristic is write-WITHOUT-response only. Lantern colour needs light channel 0xFF and a 10-byte `AAF4` payload (8-byte frames are silently ignored). Effects 1 flame / 2 blinking / 3 sweep. Moods: calm = FF3C00 flame, wary = CE1EFF sweep, ward = E7FFFC blinking.
- Movement (`AACA`) does NOT move her by itself — it selects which parts animate WHILE SHE PLAYS SOUND. Bits: 1 wrist, 2 left arm lift, 16 head (own pattern, no positional control), 32 eyes, 255 all. Mouth always follows audio. Her RIGHT hand holds the lantern and never moves; the LEFT arm moves (empty, palm up).
- Motors start disarmed (safety interlock); the greeter arms them at connect (`autoArm`). Disarm/disconnect forces movement off.
- Pre-roll hum: a 92 Hz / 700 ms / 0.08 tone joined in front of every line (one file) makes her move on the first word; leading silence in each line is trimmed.
- Built-in phrases: serials 1–6 (fallback when there's no ElevenLabs voice).
- Linux needs `libspa-0.2-bluetooth` and `~/.config/wireplumber/wireplumber.conf.d/51-bluez-headless.conf` (`monitor.bluez.seat-monitoring = disabled`, else Bluetooth audio fails `br-connection-unknown` without a desktop login) and `52-bluez-no-suspend.conf` (her sink never suspends). setup-linux.sh writes both.
- Her audio is pinned to her sink with `PULSE_SINK` — never make it the system default.
- Use Ethernet: on the haunt machine a USB Wi-Fi+BT dongle dropped Wi-Fi while streaming to her.
- Measured on the haunt machine (Ethernet): Claude reply ~1–1.7 s, ElevenLabs flash ~0.45 s.

## Status (2026-10-17)
- Tested in a cloud container with simulated parts: setup page, camera motion (synthetic video), JPEG pipe, chime learn/detect (synthetic tones), every greeting/team/outfit decision (fake faces + fake Claude), USB bundle unpack.
- NOT yet run for real: Lily over Bluetooth on this machine, the webcam, the mic/chime, whisper, the Claude and ElevenLabs calls, and actual face matching (the models couldn't be downloaded in the cloud — setup-linux.sh fetches them). Expect first-run fixes here.
- Test without hardware: `LILY_DRIVER=mock`; camera device / mic source can be `lavfi:<ffmpeg graph>` (e.g. `lavfi:testsrc2=s=640x480:r=10`); `FACES_PYTHON` overrides the Python used for faces.
- Ideas not built: per-visitor goodbye on exit, logging greetings to a file.
