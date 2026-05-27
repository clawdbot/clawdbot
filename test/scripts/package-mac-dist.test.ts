import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/package-mac-dist.sh";

function makePlist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-plist-"));
  tempDirs.push(dir);
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "<key>CFBundleShortVersionString</key>",
      "<string>1.2.3</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return plist;
}

function runHelper(script: string) {
  return spawnSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("package-mac-dist plist validation", () => {
  it("fails closed for required Info.plist reads", () => {
    const script = readFileSync(scriptPath, "utf8");
    const readBlock = script.slice(
      script.indexOf("VERSION="),
      script.indexOf('ZIP="$ROOT_DIR/dist/OpenClaw-$VERSION.zip"'),
    );

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/plistbuddy.sh"');
    expect(readBlock).toContain(
      'VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"',
    );
    expect(readBlock).toContain(
      'BUNDLE_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleVersion)"',
    );
    expect(readBlock).toContain(
      'ACTUAL_BUNDLE_ID="$(plist_print_required "$APP/Contents/Info.plist" CFBundleIdentifier)"',
    );
    expect(readBlock).toContain(
      'ACTUAL_FEED_URL="$(plist_print_required "$APP/Contents/Info.plist" SUFeedURL)"',
    );
    expect(readBlock).not.toContain("PlistBuddy");
    expect(readBlock).not.toContain("|| echo");
  });

  it("requires the release bundle id to match the configured bundle id", () => {
    const script = readFileSync(scriptPath, "utf8");
    const releaseBlock = script.slice(
      script.indexOf('if [[ "$BUILD_CONFIG" == "release" ]]'),
      script.indexOf('if [[ "$NOTARIZE" == "1" ]]'),
    );

    expect(releaseBlock).toContain('if [[ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]]');
    expect(releaseBlock).toContain("expected '$BUNDLE_ID'");
    expect(releaseBlock).not.toContain("*.debug");
  });

  it("fails closed when required dSYM outputs are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const dsymBlock = script.slice(script.indexOf('if [[ "$SKIP_DSYM" != "1" ]]'));

    expect(dsymBlock).toContain('for arch in "${DSYM_ARCHS[@]}"');
    expect(dsymBlock).toContain('if [[ ! -d "$BUILD_ROOT/$arch" ]]; then');
    expect(dsymBlock).toContain('MISSING_DSYM_ARCHS+=("$arch")');
    expect(dsymBlock).toContain("Error: dSYM not found for architecture(s):");
    expect(dsymBlock).not.toContain('find "$BUILD_ROOT/arm64"');
    expect(dsymBlock).not.toContain('find "$BUILD_ROOT/x86_64"');
    expect(dsymBlock).toContain("Error: missing DWARF binaries for dSYM merge");
    expect(dsymBlock).toContain("Error: dSYM not found");
    expect(dsymBlock).toContain("exit 1");
    expect(dsymBlock).not.toContain("WARN:");
    expect(dsymBlock).not.toContain("continuing");
  });

  it.runIf(process.platform === "darwin")(
    "prints required plist keys and fails when a key is missing",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_print_required ${JSON.stringify(plist)} CFBundleShortVersionString
        plist_print_required ${JSON.stringify(plist)} CFBundleVersion
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("1.2.3");
      expect(result.stderr).toContain("Does Not Exist");
    },
  );
});
