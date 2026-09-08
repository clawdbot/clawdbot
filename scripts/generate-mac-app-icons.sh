#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/AppIcons"
MODE="${1:---write}"
if [[ "$MODE" != "--write" && "$MODE" != "--check" ]]; then
  echo "Usage: /bin/bash scripts/generate-mac-app-icons.sh [--write|--check]" >&2
  exit 1
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$OUTPUT_DIR"

# Each family has editable vector artwork; actool owns the macOS mask and padding.
/usr/bin/python3 - "$ROOT_DIR/apps/macos" "$WORK_DIR" <<'PY'
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

root, work = map(Path, sys.argv[1:])
for name, (source, dark_fill, dark_foreground) in {
    "paper": ("Icon.icon", {"linear-gradient": ["srgb:0.19200,0.19200,0.19200,1.00000", "srgb:0.07800,0.07800,0.07800,1.00000"]}, None),
    "heritage": ("AppIconDesigns/Heritage.icon", {"solid": "srgb:0.13333,0.13333,0.13333,1.00000"}, None),
    "clawmark": ("AppIconDesigns/Clawmark.icon", {"solid": "srgb:0.10196,0.10980,0.12157,1.00000"}, None),
    "origami": ("AppIconDesigns/Origami.icon", {"solid": "srgb:0.07451,0.12549,0.20000,1.00000"}, None),
    "pincer": ("AppIconDesigns/Pincer.icon", {"solid": "srgb:0.16863,0.18039,0.18824,1.00000"}, "#f8f5ec"),
    "openC": ("AppIconDesigns/OpenC.icon", {"solid": "srgb:0.16863,0.18039,0.18824,1.00000"}, "#f8f5ec"),
}.items():
    for appearance in ("light", "dark"):
        icon = work / f"{name}-{appearance}" / "Icon.icon"
        shutil.copytree(root / source, icon)
        if appearance == "dark":
            document = json.loads((icon / "icon.json").read_text())
            document["fill"] = dark_fill
            (icon / "icon.json").write_text(json.dumps(document, indent=2) + "\n")
            if dark_foreground:
                # Monochrome pairs invert the glyph as well as the tile.
                ET.register_namespace("", "http://www.w3.org/2000/svg")
                artwork = icon / "Assets" / "molty.svg"
                tree = ET.parse(artwork)
                tree.getroot().set("fill", dark_foreground)
                tree.write(artwork, encoding="unicode")
PY

for style in paper-light paper-dark heritage-light heritage-dark clawmark-light clawmark-dark origami-light origami-dark pincer-light pincer-dark openC-light openC-dark; do
  mkdir "$WORK_DIR/$style/compiled"
  xcrun actool "$WORK_DIR/$style/Icon.icon" \
    --compile "$WORK_DIR/$style/compiled" \
    --output-format human-readable-text --notices --warnings --errors \
    --output-partial-info-plist "$WORK_DIR/$style/compiled/icon.plist" \
    --app-icon Icon --include-all-app-icons --enable-on-demand-resources NO \
    --development-region en --target-device mac --minimum-deployment-target 15.0 --platform macosx
  if [[ "$MODE" == "--check" ]]; then
    if ! cmp -s "$WORK_DIR/$style/compiled/Icon.icns" "$OUTPUT_DIR/$style.icns"; then
      echo "Stale $style icon. Run /bin/bash scripts/generate-mac-app-icons.sh with the current Xcode toolchain." >&2
      exit 1
    fi
  else
    cp "$WORK_DIR/$style/compiled/Icon.icns" "$OUTPUT_DIR/$style.icns"
  fi
done

if [[ "$MODE" == "--check" ]]; then
  cmp "$OUTPUT_DIR/paper-light.icns" "$OUTPUT_DIR/../OpenClaw.icns"
else
  cp "$OUTPUT_DIR/paper-light.icns" "$OUTPUT_DIR/../OpenClaw.icns"
fi
