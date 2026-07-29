// Make Appcast tests cover release appcast script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/make_appcast.sh";

describe("make_appcast cleanup", () => {
  it("does not reference release notes before their path is assigned", () => {
    const script = readFileSync(scriptPath, "utf8");
    const setupBlock = script.slice(
      script.indexOf('TMP_DIR="$(mktemp -d)"'),
      script.indexOf('cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"'),
    );

    expect(setupBlock).toContain('NOTES_HTML=""');
    expect(setupBlock.indexOf('NOTES_HTML=""')).toBeLessThan(
      setupBlock.indexOf("trap cleanup EXIT"),
    );
    expect(setupBlock).toContain(
      'if [[ -n "$NOTES_HTML" && "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then',
    );
    expect(setupBlock).toContain('rm -f "$NOTES_HTML"');
  });

  it("adds the beta channel and refuses alpha releases", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('if [[ "$VERSION" == *-beta.* || "$VERSION" == *.beta.* ]]; then');
    expect(script).toContain("CHANNEL_ARGS=(--channel beta)");
    expect(script).toContain('if [[ "$VERSION" == *-alpha.* || "$VERSION" == *.alpha.* ]]; then');
    expect(script).toContain('"${CHANNEL_ARGS[@]}"');
  });

  it("prefers the host-architecture Sparkle tool and requires a signed entry", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('if [[ -n "${SPARKLE_GENERATE_APPCAST:-}" ]]');
    expect(script).toContain('"$ROOT/apps/macos/.build/$host_arch"');
    expect(script).toContain('if [[ -d "$bundled_root" ]]');
    expect(script.indexOf('"$ROOT/apps/macos/.build/$host_arch"')).toBeLessThan(
      script.indexOf("command -v generate_appcast"),
    );
    expect(script).toContain("is missing sparkle:edSignature");
  });
});
