// Package Mac Dist tests cover package mac dist script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/package-mac-dist.sh";

function makeDistributionFixture(layout: "native" | "xcode", missingArch?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-dist-symbols-"));
  tempDirs.push(root);
  const scripts = path.join(root, "scripts");
  const tools = path.join(root, "tools");
  mkdirSync(path.join(scripts, "lib"), { recursive: true });
  mkdirSync(tools);
  for (const file of [
    "package-mac-dist.sh",
    "notarize-mac-artifact.sh",
    "lib/mac-notarization-recovery.py",
    "lib/plistbuddy.sh",
    "lib/swift-toolchain.sh",
  ]) {
    copyFileSync(path.join("scripts", file), path.join(scripts, file));
  }
  const executable = (file: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  };
  executable(path.join(scripts, "package-mac-app.sh"), "exit 0");
  executable(path.join(tools, "swift"), "echo 'Apple Swift version 6.3'");
  executable(path.join(tools, "xcrun"), "echo 'Xcode 26.4'");
  executable(path.join(tools, "node"), "echo 2608000290");
  const contents = path.join(root, "dist", "OpenClaw.app", "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>2026.8.2</string>
<key>CFBundleVersion</key><string>2608000290</string>
<key>CFBundleIdentifier</key><string>ai.openclaw.mac</string>
<key>SUFeedURL</key><string>https://example.com/appcast.xml</string>
</dict></plist>`,
  );
  const source = path.join(root, "main.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const expectedUUIDs: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const build = path.join(root, "apps", "macos", ".build", arch);
    const products = path.join(
      build,
      layout === "xcode" ? "out/Products/Release" : `${arch}-apple-macosx/release`,
    );
    mkdirSync(products, { recursive: true });
    symlinkSync(path.relative(build, products), path.join(build, "release"));
    if (arch === missingArch) {
      continue;
    }
    const binary = path.join(products, "OpenClaw");
    const symbols = `${binary}.dSYM`;
    for (const args of [
      ["clang", "-arch", arch, "-g", source, "-o", binary],
      ["dsymutil", binary, "-o", symbols],
    ]) {
      const result = spawnSync("xcrun", args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const uuid = spawnSync("xcrun", ["dwarfdump", "--uuid", binary], { encoding: "utf8" });
    expect(uuid.status, uuid.stderr).toBe(0);
    expectedUUIDs.push(uuid.stdout.trim().split(" ").slice(0, 3).join(" "));
  }
  return {
    root,
    expectedUUIDs,
    run: (options: { resume?: boolean; notarize?: boolean } = {}) =>
      spawnSync(
        "bash",
        [
          path.join(scripts, "package-mac-dist.sh"),
          ...(options.resume ? ["--resume-notarization"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${tools}:/usr/bin:/bin`,
            APP_VERSION: "2026.8.2",
            APP_BUILD: "2608000290",
            BUILD_CONFIG: "release",
            BUILD_ARCHS: "all",
            SKIP_NOTARIZE: options.notarize ? "0" : "1",
            NOTARYTOOL_PROFILE: "test-profile",
            SKIP_DMG: "1",
            SKIP_DSYM: "0",
          },
        },
      ),
  };
}

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

  it("marks the distributed Control UI as an official release artifact", () => {
    const script = readFileSync(scriptPath, "utf8");
    const releaseMarkerIndex = script.indexOf("export OPENCLAW_CONTROL_UI_RELEASE_BUILD=1");
    const packageAppIndex = script.indexOf('"$ROOT_DIR/scripts/package-mac-app.sh"');

    expect(releaseMarkerIndex).toBeGreaterThanOrEqual(0);
    expect(packageAppIndex).toBeGreaterThan(releaseMarkerIndex);
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
    const swiftIndex = script.indexOf("  require_swift_toolchain\n");
    const versionIndex = script.indexOf('if [[ -z "$APP_VERSION_INPUT" ]]');
    const appBuildIndex = script.indexOf(
      'if [[ "$RESUME_NOTARIZATION" == "0" && -z "${APP_BUILD:-}" && "$BUILD_CONFIG" == "release" ]]',
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
      path.join(toolsDir, "xcrun"),
      [
        "#!/usr/bin/env bash",
        '[[ "${1:-}" == "xcodebuild" && "${2:-}" == "-version" ]] || exit 2',
        "echo 'Xcode 26.4'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path.join(toolsDir, "xcrun"), 0o755);
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
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Swift tools 6.3+");
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

  it.runIf(process.platform === "darwin")(
    "resumes without build products and allows the next fresh package after success",
    () => {
      const fixture = makeDistributionFixture("native");
      const app = path.join(fixture.root, "dist/OpenClaw.app");
      const plist = path.join(app, "Contents/Info.plist");
      writeFileSync(
        plist,
        readFileSync(plist, "utf8").replace(
          "</dict>",
          "<key>CFBundleExecutable</key><string>OpenClaw</string></dict>",
        ),
      );
      mkdirSync(path.join(app, "Contents/MacOS"));
      copyFileSync(
        path.join(fixture.root, "apps/macos/.build/arm64/release/OpenClaw"),
        path.join(app, "Contents/MacOS/OpenClaw"),
      );
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
        encoding: "utf8",
      });
      expect(signed.status, signed.stderr).toBe(0);
      for (const args of [
        ["init", "--quiet"],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ],
      ]) {
        const result = spawnSync("git", args, { cwd: fixture.root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      }
      const tools = path.join(fixture.root, "tools");
      const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" });
      expect(jq.status).toBe(0);
      symlinkSync(jq.stdout.trim(), path.join(tools, "jq"));
      writeFileSync(
        path.join(tools, "xcrun"),
        `#!/bin/bash
set -eu
root="$(dirname "$0")/.."
if [[ "$1" != notarytool ]]; then echo 'Xcode 26.4'; exit 0; fi
if [[ "$2" == submit ]]; then
  echo submit >> "$root/submissions"
  if [[ "$*" == *" --wait "* ]]; then echo 'network disconnected' >&2; exit 7; fi
  echo '{"id":"11111111-2222-3333-4444-555555555555"}'
elif [[ ! -f "$root/wait-failed" ]]; then
  touch "$root/wait-failed"
  echo 'network disconnected' >&2
  exit 7
else
  echo '{"id":"11111111-2222-3333-4444-555555555555","status":"Accepted"}'
fi
`,
        { mode: 0o755 },
      );
      const failed = fixture.run({ notarize: true });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("network disconnected");
      const checkpoint = path.join(fixture.root, "dist/macos-notarization-recovery");
      expect(existsSync(path.join(checkpoint, "app.zip"))).toBe(true);
      expect(existsSync(path.join(checkpoint, "symbols.zip"))).toBe(true);
      renameSync(path.join(fixture.root, "apps"), path.join(fixture.root, "saved-build-products"));
      writeFileSync(
        path.join(fixture.root, "scripts/package-mac-app.sh"),
        "#!/bin/bash\necho 'unexpected rebuild' >&2\nexit 97\n",
      );
      const resumed = fixture.run({ resume: true, notarize: true });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(readFileSync(path.join(fixture.root, "submissions"), "utf8")).toBe("submit\n");
      expect(existsSync(path.join(fixture.root, "dist/OpenClaw-2026.8.2.zip"))).toBe(true);
      expect(existsSync(path.join(fixture.root, "dist/OpenClaw-2026.8.2.dSYM.zip"))).toBe(true);
      renameSync(path.join(fixture.root, "saved-build-products"), path.join(fixture.root, "apps"));
      writeFileSync(
        path.join(fixture.root, "scripts/package-mac-app.sh"),
        "#!/bin/bash\ntouch fresh-build-started\n",
      );
      const fresh = fixture.run({ notarize: true });
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(existsSync(path.join(fixture.root, "fresh-build-started"))).toBe(true);
      expect(readFileSync(path.join(fixture.root, "submissions"), "utf8")).toBe("submit\nsubmit\n");
    },
  );

  it("fails closed when required dSYM outputs are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const dsymBlock = script.slice(script.indexOf('if [[ "$SKIP_DSYM" != "1" ]]'));

    expect(dsymBlock).toContain('for arch in "${DSYM_ARCHS[@]}"');
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

describe.runIf(process.platform === "darwin")("package-mac-dist symbol archives", () => {
  it.each(["native", "xcode"] as const)(
    "archives matching universal symbols from the %s build output",
    (layout) => {
      const fixture = makeDistributionFixture(layout);
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      const archive = path.join(fixture.root, "dist", "OpenClaw-2026.8.2.dSYM.zip");
      const extracted = path.join(fixture.root, "extracted");
      const unpack = spawnSync("ditto", ["-x", "-k", archive, extracted], { encoding: "utf8" });
      expect(unpack.status, unpack.stderr).toBe(0);
      const uuid = spawnSync(
        "xcrun",
        ["dwarfdump", "--uuid", path.join(extracted, "OpenClaw.dSYM")],
        { encoding: "utf8" },
      );
      expect(uuid.status, uuid.stderr).toBe(0);
      expect(
        uuid.stdout
          .trim()
          .split("\n")
          .map((line) => line.split(" ").slice(0, 3).join(" "))
          .sort(),
      ).toEqual(fixture.expectedUUIDs.sort());
      expect(existsSync(path.join(fixture.root, "dist", "OpenClaw.dSYM"))).toBe(false);
    },
  );

  it("refuses a universal archive when one architecture has no symbols", () => {
    const fixture = makeDistributionFixture("xcode", "x86_64");
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dSYM not found for architecture(s): x86_64");
    expect(existsSync(path.join(fixture.root, "dist", "OpenClaw-2026.8.2.dSYM.zip"))).toBe(false);
  });
});
