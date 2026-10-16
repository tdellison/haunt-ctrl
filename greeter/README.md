# Lily — work door greeter

Lily (Lethal Lily) greeting visitors at the office door. Separate from the
Halloween show: it reuses `../lily` (her Bluetooth body, lantern and speaker)
and nothing else.

## How it behaves
- **Camera (main sensor)** — a USB webcam watches a box you draw over the door.
  Someone walks in → she lights her lantern, moves, and says a greeting line.
- **Door chime (backup)** — the mic learns your chime. If it rings and the
  camera hasn't greeted anyone in the last 15 s, she waits 3 s for the camera,
  then says hello anyway.
- **Conversation** — after each greeting the mic opens for 15 s. If the visitor
  talks, whisper.cpp turns it into text, Claude (Haiku) writes her reply using
  the **office notes** you type on the setup page, ElevenLabs speaks it in her
  voice. Each reply re-opens the window; silence closes it. Outside a window
  she ignores the room, so staff chatting nearby don't get answered.
- **Guards** — 20 s cooldown (a group = one hello), greeting hours (default
  8:00–18:00 weekdays), and **Team pause** buttons for when staff are coming
  and going. Greeting lines are voiced once and cached, so a hello is instant.
- If her speaker isn't connected she talks through the computer's speaker;
  with no ElevenLabs key she plays one of her built-in phrases.

## Put it on the work machine (USB)
On a machine with this repo (the OptiPlex):
```
bash greeter/make-usb-bundle.sh              # -> lily-greeter.tar.gz (~5 MB)
bash greeter/make-usb-bundle.sh --with-keys  # also carries the Claude + ElevenLabs keys
```
Copy `lily-greeter.tar.gz` to the USB stick. On the work Linux machine
(Ubuntu/Debian, wired network, internet needed once for setup):
```
tar xzf lily-greeter.tar.gz -C ~
bash ~/lily-greeter/greeter/setup-linux.sh
```
Setup installs ffmpeg, Bluetooth audio (PipeWire + `libspa-0.2-bluetooth`),
Node 22, builds whisper.cpp, OpenCV + the two face models, adds the WirePlumber configs her speaker needs,
and starts the greeter at every boot (`systemctl --user … lily-greeter`).
Log out and back in once afterwards.

## First-time setup (http://<machine-ip>:3100)
1. **API keys** — paste the Anthropic (Claude) and ElevenLabs keys (skip if
   you used `--with-keys`).
2. **Lily** — turn her on, *Connect body*, then *Pair + connect speaker*. Her
   addresses are prefilled (body 1A:74:89:6F:37:DB, speaker 1A:74:89:F2:ED:95);
   *Scan Bluetooth* if they differ. Motors arm automatically (she only moves
   while she's speaking).
3. **Camera** — pick the webcam, then click the picture twice to draw the box
   over the doorway. Walk in and watch the motion meter; raise *area %* if it
   triggers on shadows, lower it if it misses people.
4. **Mic** — pick the USB mic, press **LEARN CHIME** and ring the chime within
   5 s.
5. **Office notes** — who visitors should ask for, sign-in, deliveries, Wi-Fi…
   She only passes on what's written there and never invents facts.
6. **Lines + hours** — edit what she says and when she's active.
   Then **GREET NOW** to hear it.

## Team recognition (optional — off until you switch it on)
Setup page → **Team**: type a name, then either *📷 Photo from Lily's
camera* (stand in front of her) or *📁 Upload photos* from a phone. 3–5
photos each: straight on, a little left/right, with/without glasses. Then tick
**Recognise team**.

When the camera fires she looks for ~2 s before speaking:
- a face she doesn't know → visitor greeting (also when a teammate is with them)
- only teammates → *"Oh, it's just you, Todd. You may go now."* (lines editable,
  `{name}` = their name), at most once per person per hour, otherwise silent
- no face (someone walking out, back to her) → silent, and the chime is
  ignored for that door opening too

Everything runs on that computer (OpenCV YuNet + SFace). Photos live in
`greeter/team/<Name>/` and never leave it — not uploaded, not sent to Claude
or ElevenLabs. *Remove* deletes a person's folder. Check with work before
adding staff photos.

If a teammate gets greeted as a stranger: add more photos of them, or lower
*Match strictness* a little (0.36–0.4). If a stranger gets called by a
teammate's name: raise it. *last seen* on the page shows the scores.

## Files (per machine, gitignored, in `greeter/`)
`greeter-config.json` (settings) · `lily-config.json` (her addresses) ·
`secrets.json` (API keys) · `cache/` (voiced lines) · `team/` (team photos) ·
`.venv/` + `models/` (face recognition, made by setup).
