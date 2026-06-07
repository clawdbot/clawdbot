// Package Mac Dist tests cover package mac dist script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("does not mask canonical Sparkle build failures for release packaging", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("ensure_sparkle_build_deps()");
    expect(script).toContain(
      "run_dist_pnpm install --frozen-lockfile --config.node-linker=hoisted >&2",
    );
    expect(script).toContain(
      '(cd "$ROOT_DIR" && node --import tsx "$ROOT_DIR/scripts/sparkle-build.ts" canonical-build "$1")',
    );
    expect(script).toContain('if [[ "$SPARKLE_BUILD_DEPS_RETRIED" == "1" ]]');
    expect(script).toContain("require_canonical_sparkle_build()");
    expect(script).toContain(
      'CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$APP_VERSION_INPUT")"',
    );
    expect(script).toContain('CANONICAL_APP_BUILD="$(require_canonical_sparkle_build "$VERSION")"');
    expect(script).not.toContain(
      'canonical_sparkle_build "$APP_VERSION_INPUT" 2>/dev/null || true',
    );
    expect(script).not.toContain('canonical_sparkle_build "$VERSION" 2>/dev/null || true');
  });

  it("keeps dependency bootstrap output out of captured Sparkle build values", () => {
    const script = readFileSync(scriptPath, "utf8");
    const helpers = script.slice(
      script.indexOf("DIST_PNPM_CMD=()"),
      script.indexOf("correction_build_from_exact_tag()"),
    );
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-sparkle-"));
    tempDirs.push(dir);
    const tools = path.join(dir, "tools");
    const marker = path.join(dir, "installed");
    const fakeNode = path.join(tools, "node");
    const fakePnpm = path.join(tools, "pnpm");

    mkdirSync(tools, { recursive: true });
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then',
        '  echo "node ran outside repo root: $PWD" >&2',
        "  exit 1",
        "fi",
        'if [[ ! -f "$OPENCLAW_MARKER" ]]; then',
        '  echo "Cannot find package tsx" >&2',
        "  exit 1",
        "fi",
        'echo "ExperimentalWarning: tsx loader changed" >&2',
        "echo 2026060200",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeNode, 0o755);
    writeFileSync(
      fakePnpm,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "echo 'Already up to date'",
        'touch "$OPENCLAW_MARKER"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(process.cwd())}
      OPENCLAW_ROOT=${JSON.stringify(process.cwd())}
      OPENCLAW_MARKER=${JSON.stringify(marker)}
      PATH=${JSON.stringify(tools)}:/usr/bin:/bin
      export OPENCLAW_MARKER OPENCLAW_ROOT PATH
      ${helpers}
      require_canonical_sparkle_build 2026.6.2
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026060200\n");
    expect(result.stderr).toContain("Ensuring deps for Sparkle build metadata");
    expect(result.stderr).toContain("Already up to date");
    expect(result.stderr).toContain("ExperimentalWarning: tsx loader changed");
  });

  it("stops when dependency bootstrap fails during Sparkle build retry", () => {
    const script = readFileSync(scriptPath, "utf8");
    const helpers = script.slice(
      script.indexOf("DIST_PNPM_CMD=()"),
      script.indexOf("correction_build_from_exact_tag()"),
    );
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-sparkle-"));
    tempDirs.push(dir);
    const tools = path.join(dir, "tools");
    const marker = path.join(dir, "installed");
    const fakeNode = path.join(tools, "node");
    const fakePnpm = path.join(tools, "pnpm");

    mkdirSync(tools, { recursive: true });
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then',
        '  echo "node ran outside repo root: $PWD" >&2',
        "  exit 1",
        "fi",
        'if [[ ! -f "$OPENCLAW_MARKER" ]]; then',
        '  echo "Cannot find package tsx" >&2',
        "  exit 1",
        "fi",
        'echo "node reran after failed install" >&2',
        "echo 2026060200",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeNode, 0o755);
    writeFileSync(
      fakePnpm,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'touch "$OPENCLAW_MARKER"',
        'echo "pnpm failed" >&2',
        "exit 42",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(process.cwd())}
      OPENCLAW_ROOT=${JSON.stringify(process.cwd())}
      OPENCLAW_MARKER=${JSON.stringify(marker)}
      PATH=${JSON.stringify(tools)}:/usr/bin:/bin
      export OPENCLAW_MARKER OPENCLAW_ROOT PATH
      ${helpers}
      require_canonical_sparkle_build 2026.6.2
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pnpm failed");
    expect(result.stderr).not.toContain("node reran after failed install");
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
