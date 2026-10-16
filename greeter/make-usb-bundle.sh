#!/usr/bin/env bash
# ─── Pack the door greeter into one file for a USB stick ──────────────────────
#     bash greeter/make-usb-bundle.sh            -> lily-greeter.tar.gz
#     bash greeter/make-usb-bundle.sh --with-keys   also copies this machine's
#        API keys (haunt secrets.json) into the bundle. The stick then holds
#        your Claude + ElevenLabs keys — keep it safe, or leave the flag off
#        and paste the keys on the setup page instead.
# On the work machine:
#     tar xzf lily-greeter.tar.gz -C ~ && bash ~/lily-greeter/greeter/setup-linux.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$REPO/lily-greeter.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/lily-greeter"
mkdir -p "$D"

cp -r "$REPO/greeter" "$REPO/lily" "$D/"
cp "$REPO/voices.json" "$REPO/package.json" "$D/"
# Only what the greeter loads — the haunt's dev/test packages stay behind.
cp -r "$REPO/node_modules" "$D/"
rm -rf "$D/node_modules/"{playwright,playwright-core,@abandonware,usb,node-gyp,.bin}
# Per-machine files never travel, except keys when asked.
rm -rf "$D/greeter/"{greeter-config.json,lily-config.json,secrets.json,cache}
rm -f "$D/lily/clips.json"
if [ "${1:-}" = "--with-keys" ]; then
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const o = {}; if (s.anthropicApiKey) o.anthropicApiKey = s.anthropicApiKey; if (s.elevenLabsApiKey) o.elevenLabsApiKey = s.elevenLabsApiKey;
    require("fs").writeFileSync(process.argv[2], JSON.stringify(o, null, 2), { mode: 0o600 });
    console.log("keys included:", Object.keys(o).join(", ") || "none found");
  ' "$REPO/secrets.json" "$D/greeter/secrets.json"
fi
tar czf "$OUT" -C "$STAGE" lily-greeter
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
