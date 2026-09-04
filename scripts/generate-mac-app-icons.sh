#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/AppIcons"
MODE="${1:---write}"
if [[ "$MODE" != "--write" && "$MODE" != "--check" ]]; then
  echo "Usage: bash scripts/generate-mac-app-icons.sh [--write|--check]" >&2
  exit 1
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$OUTPUT_DIR"

# All choices share the same mascot geometry and native macOS mask/effects.
/usr/bin/python3 - "$ROOT_DIR/apps/macos/Icon.icon" "$WORK_DIR" <<'PY'
import json
import shutil
import sys
from pathlib import Path

source, work = map(Path, sys.argv[1:])
for name, color in {
    "paper": None,
    "ink": "0.09804,0.09804,0.10980,1.00000",
    "seaGlass": "0.87843,0.95686,0.93333,1.00000",
}.items():
    icon = work / name / "Icon.icon"
    shutil.copytree(source, icon)
    document = json.loads((icon / "icon.json").read_text())
    if color is not None:
        document["fill"] = {"solid": "extended-srgb:" + color}
    (icon / "icon.json").write_text(json.dumps(document, indent=2) + "\n")
PY

for style in paper ink seaGlass; do
  mkdir "$WORK_DIR/$style/compiled"
  xcrun actool "$WORK_DIR/$style/Icon.icon" \
    --compile "$WORK_DIR/$style/compiled" \
    --output-format human-readable-text --notices --warnings --errors \
    --output-partial-info-plist "$WORK_DIR/$style/compiled/icon.plist" \
    --app-icon Icon --include-all-app-icons --enable-on-demand-resources NO \
    --development-region en --target-device mac --minimum-deployment-target 15.0 --platform macosx
  if [[ "$MODE" == "--check" ]]; then
    if ! cmp -s "$WORK_DIR/$style/compiled/Icon.icns" "$OUTPUT_DIR/$style.icns"; then
      echo "Stale $style icon. Run bash scripts/generate-mac-app-icons.sh with the current Xcode toolchain." >&2
      exit 1
    fi
  else
    cp "$WORK_DIR/$style/compiled/Icon.icns" "$OUTPUT_DIR/$style.icns"
  fi
done

if [[ "$MODE" == "--check" ]]; then
  cmp "$OUTPUT_DIR/paper.icns" "$OUTPUT_DIR/../OpenClaw.icns"
else
  cp "$OUTPUT_DIR/paper.icns" "$OUTPUT_DIR/../OpenClaw.icns"
fi
