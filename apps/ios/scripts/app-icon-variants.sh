#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
release_icon_set="$repo_root/apps/ios/Sources/Assets.xcassets/AppIcon.appiconset"
debug_icon_set="$repo_root/apps/ios/Sources/Assets.xcassets/AppIconDebug.appiconset"
source_svg="$repo_root/ui/public/favicon.svg"
debug_renderer="$repo_root/apps/ios/scripts/app-icon-debug-dark.swift"

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "app-icon-variants: missing $command_name; $install_hint" >&2
    exit 1
  fi
}

preflight() {
  require_command node "install the repository's required Node.js version"
  require_command xcrun "install Xcode command-line tools"
  if [[ ! -x /usr/bin/sips ]]; then
    echo "app-icon-variants: /usr/bin/sips is required; run this generator on macOS" >&2
    exit 1
  fi
  if ! xcrun --find swift >/dev/null 2>&1; then
    echo "app-icon-variants: Swift is required; select a complete Xcode toolchain" >&2
    exit 1
  fi
}

render_release_dark_icon() {
  local output="$1"
  /usr/bin/sips -z 1024 1024 -s format png "$source_svg" --out "$output" >/dev/null
}

render_debug_dark_icon() {
  local output="$1"
  xcrun swift "$debug_renderer" "$debug_icon_set/1024.png" "$output"
}

check_manifests() {
  node - \
    "$release_icon_set/Contents.json" "$release_icon_set" \
    "$debug_icon_set/Contents.json" "$debug_icon_set" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const inputs = process.argv.slice(2);
const luminosity = (image) =>
  image.appearances?.find((entry) => entry.appearance === "luminosity")?.value;

for (let index = 0; index < inputs.length; index += 2) {
  const manifestPath = inputs[index];
  const iconSetPath = inputs[index + 1];
  const catalogName = path.basename(iconSetPath, ".appiconset");
  const { images } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dark = images.filter((image) => luminosity(image) === "dark");
  const tinted = images.filter((image) => luminosity(image) === "tinted");
  const marketing = images.filter(
    (image) =>
      image.idiom === "ios-marketing" &&
      image.size === "1024x1024" &&
      image.scale === "1x",
  );

  if (
    marketing.length !== 1 ||
    marketing[0].filename !== "1024.png" ||
    dark.length !== 1 ||
    dark[0].filename !== "1024-dark.png" ||
    dark[0].idiom !== "universal" ||
    dark[0].platform !== "ios" ||
    dark[0].size !== "1024x1024" ||
    tinted.length !== 1 ||
    Object.hasOwn(tinted[0], "filename") ||
    tinted[0].idiom !== "universal" ||
    tinted[0].platform !== "ios" ||
    tinted[0].size !== "1024x1024"
  ) {
    throw new Error(
      `${catalogName} must declare its existing Default image, one custom Dark image, and one automatic Tinted slot`,
    );
  }

  for (const filename of new Set(images.flatMap((image) => image.filename ?? []))) {
    if (!fs.existsSync(path.join(iconSetPath, filename))) {
      throw new Error(`${catalogName} references missing file: ${filename}`);
    }
  }
}
NODE
}

check_pngs() {
  node - \
    "$release_icon_set/1024.png" opaque any \
    "$release_icon_set/1024-dark.png" alpha srgb \
    "$debug_icon_set/1024.png" opaque srgb \
    "$debug_icon_set/1024-dark.png" alpha srgb <<'NODE'
const fs = require("node:fs");

const inputs = process.argv.slice(2);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

for (let index = 0; index < inputs.length; index += 3) {
  const imagePath = inputs[index];
  const alphaExpectation = inputs[index + 1];
  const profileExpectation = inputs[index + 2];
  const data = fs.readFileSync(imagePath);
  if (!data.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${imagePath} is not a PNG`);
  }

  let offset = 8;
  let header;
  let hasSRGBChunk = false;
  let iccProfileName;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
      };
    } else if (type === "sRGB") {
      hasSRGBChunk = true;
    } else if (type === "iCCP") {
      iccProfileName = body.subarray(0, body.indexOf(0)).toString("latin1");
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }

  if (
    !header ||
    header.width !== 1024 ||
    header.height !== 1024 ||
    header.bitDepth !== 8
  ) {
    throw new Error(`${imagePath} must be an 8-bit 1024x1024 PNG`);
  }

  const hasAlphaChannel = header.colorType === 4 || header.colorType === 6;
  if ((alphaExpectation === "alpha") !== hasAlphaChannel) {
    throw new Error(`${imagePath} has an unexpected PNG alpha-channel shape`);
  }

  if (
    profileExpectation === "srgb" &&
    !hasSRGBChunk &&
    !iccProfileName?.toLowerCase().startsWith("srgb")
  ) {
    throw new Error(`${imagePath} must declare an sRGB color profile`);
  }
}
NODE
}

case "${1:-check}" in
  generate)
    preflight
    render_release_dark_icon "$release_icon_set/1024-dark.png"
    render_debug_dark_icon "$debug_icon_set/1024-dark.png"
    ;;
  check)
    preflight
    check_manifests
    check_pngs

    temp_dir="$(mktemp -d /tmp/openclaw-app-icon-variants.XXXXXX)"
    trap 'rm -rf "$temp_dir"' EXIT
    render_release_dark_icon "$temp_dir/1024-dark.png"
    render_debug_dark_icon "$temp_dir/1024-debug-dark.png"
    cmp "$release_icon_set/1024-dark.png" "$temp_dir/1024-dark.png"
    cmp "$debug_icon_set/1024-dark.png" "$temp_dir/1024-debug-dark.png"
    echo "AppIcon and AppIconDebug Default, Dark, and automatic Tinted variants are valid."
    ;;
  *)
    echo "usage: $0 [generate|check]" >&2
    exit 2
    ;;
esac
