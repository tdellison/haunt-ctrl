#!/usr/bin/env bash
# ─── Lily door greeter — one-time setup on the work Linux machine ─────────────
# Run as your normal user (NOT with sudo) from the unpacked folder:
#     bash greeter/setup-linux.sh
# It asks for your password when it needs sudo. Safe to run again.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "== Lily greeter setup in $APP_DIR"

echo "== System packages (ffmpeg, Bluetooth audio, build tools)"
sudo apt-get update
sudo apt-get install -y ffmpeg bluez pipewire pipewire-pulse wireplumber libspa-0.2-bluetooth \
  curl git build-essential cmake python3-venv

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "   node $(node -v)"

echo "== Permissions: webcam (video), audio, bluetooth"
sudo usermod -aG video,audio,bluetooth "$USER"

echo "== WirePlumber: Bluetooth audio without a desktop login, and never let her speaker nap"
WP="$HOME/.config/wireplumber/wireplumber.conf.d"
mkdir -p "$WP"
cat > "$WP/51-bluez-headless.conf" <<'CONF'
# Run Bluetooth audio even with no active local seat (service / SSH).
wireplumber.profiles = {
  main = {
    monitor.bluez.seat-monitoring = disabled
  }
}
CONF
cat > "$WP/52-bluez-no-suspend.conf" <<'CONF'
# Lily's speaker must never suspend — the first word would be clipped.
monitor.bluez.rules = [
  {
    matches = [ { node.name = "~bluez_output.*" } ]
    actions = { update-props = { session.suspend-timeout-seconds = 0 } }
  }
]
CONF

echo "== whisper.cpp (speech-to-text, runs locally)"
if [ ! -x "$HOME/whisper.cpp/build/bin/whisper-cli" ]; then
  [ -d "$HOME/whisper.cpp" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$HOME/whisper.cpp"
  cmake -S "$HOME/whisper.cpp" -B "$HOME/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$HOME/whisper.cpp/build" -j"$(nproc)" --config Release
fi
if [ ! -f "$HOME/whisper.cpp/models/ggml-base.en.bin" ]; then
  bash "$HOME/whisper.cpp/models/download-ggml-model.sh" base.en
fi

echo "== Team face recognition (OpenCV, runs locally — off until you switch it on)"
if [ ! -x "$APP_DIR/greeter/.venv/bin/python" ]; then python3 -m venv "$APP_DIR/greeter/.venv"; fi
"$APP_DIR/greeter/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/greeter/.venv/bin/pip" install -q opencv-python-headless numpy
mkdir -p "$APP_DIR/greeter/models"
fetch_model() {  # $1 = zoo folder, $2 = file
  local out="$APP_DIR/greeter/models/$2"
  [ -s "$out" ] && [ "$(stat -c%s "$out")" -gt 100000 ] && return 0
  curl -fsSL -o "$out" "https://github.com/opencv/opencv_zoo/raw/main/models/$1/$2" \
    || curl -fsSL -o "$out" "https://huggingface.co/opencv/$1/resolve/main/$2"
  # A tiny file is an error page, not a model.
  [ "$(stat -c%s "$out")" -gt 100000 ] || { echo "   could not download $2"; rm -f "$out"; return 1; }
}
fetch_model face_detection_yunet face_detection_yunet_2023mar.onnx
fetch_model face_recognition_sface face_recognition_sface_2021dec.onnx

echo "== Local version history (so changes made later can be undone)"
if [ ! -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" init -q
  git -C "$APP_DIR" add -A
  git -C "$APP_DIR" -c user.name=Claude -c user.email=noreply@anthropic.com commit -qm "Lily greeter as delivered"
fi

echo "== Start automatically at boot (systemd user service)"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/lily-greeter.service" <<UNIT
[Unit]
Description=Lily door greeter
After=pipewire.service wireplumber.service

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/greeter/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user restart wireplumber || true
systemctl --user enable --now lily-greeter.service

IP="$(hostname -I | awk '{print $1}')"
echo
echo "== Done. Open http://$IP:3100 from a phone or browser on the work network."
echo "   Log:     journalctl --user -u lily-greeter -f"
echo "   Restart: systemctl --user restart lily-greeter"
echo "   (Log out and back in once so the webcam/bluetooth group change applies.)"
echo "   Claude Code: cd $APP_DIR && claude   (CLAUDE.md there has the full project notes)"
