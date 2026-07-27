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

function getPackageManagerHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("DIST_PNPM_CMD=()");
  const end = script.indexOf("ensure_sparkle_build_deps()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
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

  it("checks Swift before Sparkle metadata or dependency bootstrap work", () => {
    const script = readFileSync(scriptPath, "utf8");
    const swiftIndex = script.indexOf("\nrequire_swift_toolchain\n");
    const versionIndex = script.indexOf('if [[ -z "$APP_VERSION_INPUT" ]]');
    const appBuildIndex = script.indexOf(
      'if [[ -z "${APP_BUILD:-}" && "$BUILD_CONFIG" == "release" ]]',
    );
    const packageAppIndex = script.indexOf('"$ROOT_DIR/scripts/package-mac-app.sh"');
    const preSwiftBlock = script.slice(0, swiftIndex);

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"');
    expect(swiftIndex).toBeGreaterThanOrEqual(0);
    expect(versionIndex).toBeGreaterThan(swiftIndex);
    expect(appBuildIndex).toBeGreaterThan(versionIndex);
    expect(packageAppIndex).toBeGreaterThan(appBuildIndex);
    expect(preSwiftBlock).not.toContain("node -p");
  });

  it("fails on old Swift before reading package metadata", () => {
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-swift-tools-"));
    tempDirs.push(toolsDir);

    writeFileSync(
      path.join(toolsDir, "swift"),
      [
        "#!/usr/bin/env bash",
        "echo 'swift-driver version: 1.115.1 Apple Swift version 6.0.3 (swiftlang-6.0.3.1.10 clang-1600.0.30.1)'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "swift"), 0o755);
    writeFileSync(
      path.join(toolsDir, "node"),
      [
        "#!/usr/bin/env bash",
        "echo 'node should not run before Swift preflight' >&2",
        "exit 42",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "node"), 0o755);

    const result = runHelper(`
      set -euo pipefail
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      BUILD_CONFIG=release bash ${scriptPath}
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Swift tools 6.2+");
    expect(result.stderr).toContain("Current Swift is 6.0");
    expect(result.stderr).not.toContain("node should not run before Swift preflight");
  });

  it("prefers repo Corepack pnpm over a global pnpm shim", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-root-"));
    const outerRoot = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-outer-"));
    const toolsDir = mkdtempSync(path.join(tmpdir(), "openclaw-dist-pnpm-tools-"));
    const logPath = path.join(tempRoot, "pnpm.log");
    tempDirs.push(tempRoot, outerRoot, toolsDir);

    writeFileSync(
      path.join(tempRoot, "package.json"),
      '{\n  "packageManager": "pnpm@11.2.2+sha512.test"\n}\n',
    );
    writeFileSync(
      path.join(outerRoot, "package.json"),
      '{\n  "packageManager": "pnpm@11.8.0+sha512.test"\n}\n',
    );
    writeFileSync(
      path.join(toolsDir, "pnpm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "global|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"',
        'if [[ "${1:-}" == "--version" ]]; then echo "11.8.0"; fi',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(toolsDir, "corepack"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "corepack|%s|%s\\n" "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"',
        'if [[ "${1:-}" == "pnpm" && "${2:-}" == "--version" ]]; then',
        '  if grep -q "pnpm@11.2.2" package.json 2>/dev/null; then echo "11.2.2"; else echo "11.8.0"; fi',
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "pnpm"), 0o755);
    chmodSync(path.join(toolsDir, "corepack"), 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_TEST_LOG=${JSON.stringify(logPath)}
      export OPENCLAW_TEST_LOG
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      cd ${JSON.stringify(outerRoot)}
      ${helperBlock}
      run_dist_pnpm --version
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("11.2.2\n");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `corepack|${tempRoot}|pnpm --version`,
      `corepack|${tempRoot}|pnpm --version`,
    ]);
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

  it("cleans the temporary notary zip when notarization exits early", () => {
    const script = readFileSync(scriptPath, "utf8");
    const notaryBlock = script.slice(
      script.indexOf('if [[ "$NOTARIZE" == "1" ]]'),
      script.indexOf('if [[ "$SKIP_DMG" != "1" ]]'),
    );

    expect(script).toContain("cleanup_notary_zip()");
    expect(notaryBlock).toContain("NOTARY_ZIP_PENDING_CLEANUP=1");
    expect(notaryBlock).toContain("trap cleanup_notary_zip EXIT");
    expect(notaryBlock).toContain(
      'STAPLE_APP_PATH="$APP" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARY_ZIP"',
    );
    expect(notaryBlock).toContain('rm -f "$NOTARY_ZIP"');
    expect(notaryBlock).toContain("NOTARY_ZIP_PENDING_CLEANUP=0");
    expect(notaryBlock).toContain("trap - EXIT");
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
    expect(script).toContain('if ! cp -R "$1" "$TMP_DSYM"; then');
    expect(dsymBlock).toContain("cleanup_tmp_dsym");
    expect(dsymBlock).toContain('copy_dsym_to_tmp "${DSYM_PATHS[0]}"');
    expect(dsymBlock).not.toContain('cp -R "${DSYM_PATHS[0]}" "$TMP_DSYM"');
    expect(dsymBlock).toContain(
      'if ! /usr/bin/lipo -create "${DWARF_INPUTS[@]}" -output "$DWARF_OUT"; then',
    );
    expect(dsymBlock).toContain('if ! ditto -c -k --keepParent "$TMP_DSYM" "$DSYM_ZIP"; then');
    expect(dsymBlock).toContain('rm -rf "$TMP_DSYM"');
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
