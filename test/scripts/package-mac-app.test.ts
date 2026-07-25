// Package Mac App tests cover package mac app script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/package-mac-app.sh";

function makePlist(): string {
  const dir = tempDirs.make("openclaw-plistbuddy-");
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "<key>CFBundleIdentifier</key>",
      "<string>old.bundle</string>",
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
  const start = script.indexOf("PNPM_CMD=()");
  const end = script.indexOf("merge_framework_machos()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSwiftToolchainBlock(): string {
  const script = readFileSync("scripts/lib/swift-toolchain.sh", "utf8");
  const start = script.indexOf("REQUIRED_SWIFT_TOOLS_MAJOR=");
  const end = script.length;

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSparkleBuildHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("sparkle_canonical_build_from_version()");
  const end = script.indexOf("build_path_for_arch()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSwiftPackageResolutionBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("run_with_locked_swift_packages()");
  const end = script.indexOf("PNPM_CMD=()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getStopPackagedAppBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("running_packaged_app_pids()");
  const end = script.indexOf("\nstop_packaged_app_if_running\n");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSwiftCompatibilityBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf('echo "📦 Copying Swift 6.2 compatibility libraries"');
  const end = script.indexOf('echo "🖼  Copying app icon"');

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function runStopPackagedAppHarness(killZeroStatus: 0 | 1) {
  const root = tempDirs.make("openclaw-package-stop-root-");
  const toolsDir = tempDirs.make("openclaw-package-stop-tools-");

  const appRoot = path.join(root, "dist", "OpenClaw.app");
  const appBinary = path.join(appRoot, "Contents", "MacOS", "OpenClaw");
  const lsofPath = path.join(toolsDir, "lsof");
  const pgrepPath = path.join(toolsDir, "pgrep");
  const sleepPath = path.join(toolsDir, "sleep");

  writeFileSync(
    lsofPath,
    ["#!/usr/bin/env bash", `printf 'n%s\\n' ${JSON.stringify(appBinary)}`].join("\n"),
    "utf8",
  );
  writeFileSync(pgrepPath, "#!/usr/bin/env bash\nprintf '123\\n'\n", "utf8");
  writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(lsofPath, 0o755);
  chmodSync(pgrepPath, 0o755);
  chmodSync(sleepPath, 0o755);

  return runHelper(`
    set -euo pipefail
    APP_ROOT=${JSON.stringify(appRoot)}
    PRODUCT=OpenClaw
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    kill() {
      if [[ "\${1:-}" == "-0" ]]; then
        return ${killZeroStatus}
      fi
      return 0
    }
    ${getStopPackagedAppBlock()}
    stop_packaged_app_if_running
  `);
}

function runSwiftCompatibilityHarness(buildConfig: "debug" | "release") {
  const root = tempDirs.make("openclaw-package-swift-root-");
  const toolsDir = tempDirs.make("openclaw-package-swift-tools-");
  const developerDir = path.join(root, "Xcode.app", "Contents", "Developer");
  const appRoot = path.join(root, "OpenClaw.app");
  const xcodeSelectPath = path.join(toolsDir, "xcode-select");

  writeFileSync(
    xcodeSelectPath,
    ["#!/usr/bin/env bash", `printf '%s\\n' ${JSON.stringify(developerDir)}`].join("\n"),
    "utf8",
  );
  chmodSync(xcodeSelectPath, 0o755);

  return runHelper(`
    set -euo pipefail
    APP_ROOT=${JSON.stringify(appRoot)}
    BUILD_CONFIG=${JSON.stringify(buildConfig)}
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    mkdir -p "$APP_ROOT/Contents/Frameworks"
    ${getSwiftCompatibilityBlock()}
  `);
}

function runSwiftPackageResolutionHarness(mutateLockfile: boolean) {
  const root = tempDirs.make("openclaw-swift-resolve-root-");
  const toolsDir = tempDirs.make("openclaw-swift-resolve-tools-");
  const resolvedFile = path.join(root, "apps", "macos", "Package.resolved");
  const swiftPath = path.join(toolsDir, "swift");

  mkdirSync(path.dirname(resolvedFile), { recursive: true });
  writeFileSync(resolvedFile, "locked\n", { encoding: "utf8", flag: "wx" });
  writeFileSync(
    swiftPath,
    [
      "#!/usr/bin/env bash",
      mutateLockfile ? `printf 'changed\\n' > ${JSON.stringify(resolvedFile)}` : ":",
    ].join("\n"),
    "utf8",
  );
  chmodSync(swiftPath, 0o755);

  const result = runHelper(`
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    ${getSwiftPackageResolutionBlock()}
    run_with_locked_swift_packages swift package --scratch-path "$ROOT_DIR/apps/macos/.build/arm64" resolve
  `);

  return { result, resolvedFile };
}

describe("package-mac-app plist stamping", () => {
  it("resolves canonical build provenance and rejects explicit invalid overrides", () => {
    const commit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const valid = runHelper(`
      source scripts/lib/build-metadata.sh
      node() { echo "unexpected Node invocation" >&2; return 97; }
      GIT_COMMIT=${JSON.stringify(commit)}
      OPENCLAW_BUILD_TIMESTAMP=2026-07-10T12:34:56.7Z
      printf '%s\n%s\n' "$(openclaw_resolve_git_commit "$PWD")" "$(openclaw_resolve_build_timestamp)"
    `);
    const invalidCommit = runHelper(`
      source scripts/lib/build-metadata.sh
      GIT_COMMIT=abc123
      openclaw_resolve_git_commit "$PWD"
    `);
    const validAlias = runHelper(`
      source scripts/lib/build-metadata.sh
      unset GIT_COMMIT GITHUB_SHA
      GIT_SHA=${JSON.stringify(commit)}
      openclaw_resolve_git_commit "$PWD"
    `);
    const invalidTimestamp = runHelper(`
      source scripts/lib/build-metadata.sh
      OPENCLAW_BUILD_TIMESTAMP=2026-99-99T12:34:56Z
      openclaw_resolve_build_timestamp
    `);
    const missingLocalCommit = runHelper(`
      source scripts/lib/build-metadata.sh
      unset GIT_COMMIT GIT_SHA GITHUB_SHA
      empty_root="$(mktemp -d)"
      openclaw_resolve_git_commit "$empty_root"
    `);
    const missingReleaseCommit = runHelper(`
      source scripts/lib/build-metadata.sh
      unset GIT_COMMIT GIT_SHA GITHUB_SHA
      empty_root="$(mktemp -d)"
      OPENCLAW_REQUIRE_BUILD_METADATA=1 openclaw_resolve_git_commit "$empty_root"
    `);
    const ambientGithubCommit = runHelper(`
      source scripts/lib/build-metadata.sh
      unset GIT_COMMIT GIT_SHA
      GITHUB_SHA=${JSON.stringify("a".repeat(40))}
      openclaw_resolve_git_commit "$PWD"
    `);
    const invalidGithubFallback = runHelper(`
      source scripts/lib/build-metadata.sh
      unset GIT_COMMIT GIT_SHA
      GITHUB_SHA=bad
      empty_root="$(mktemp -d)"
      openclaw_resolve_git_commit "$empty_root"
    `);
    const checkedOutCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).stdout.trim();

    expect(valid.status).toBe(0);
    expect(valid.stdout).toBe(`${commit.toLowerCase()}\n2026-07-10T12:34:56.700Z\n`);
    expect(invalidCommit.status).toBe(1);
    expect(invalidCommit.stderr).toContain(
      "GIT_COMMIT must be a full 40-character hexadecimal commit",
    );
    expect(validAlias.status).toBe(0);
    expect(validAlias.stdout).toBe(commit.toLowerCase());
    expect(invalidTimestamp.status).toBe(1);
    expect(invalidTimestamp.stderr).toContain(
      "OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp",
    );
    expect(missingLocalCommit.status).toBe(0);
    expect(missingLocalCommit.stdout).toBe("unknown");
    expect(missingReleaseCommit.status).toBe(1);
    expect(missingReleaseCommit.stderr).toContain("full Git commit for the release build");
    expect(ambientGithubCommit.status).toBe(0);
    expect(ambientGithubCommit.stdout).toBe(checkedOutCommit);
    expect(invalidGithubFallback.status).toBe(1);
    expect(invalidGithubFallback.stderr).toContain(
      "GITHUB_SHA must be a full 40-character hexadecimal commit",
    );
  });

  it("normalizes valid timestamps without requiring host Node", () => {
    const result = runHelper(`
      source scripts/lib/build-metadata.sh
      node() { echo "unexpected Node invocation" >&2; return 97; }
      for value in \
        0000-01-01T00:00:00Z \
        2000-02-29T23:59:59.7Z \
        2024-02-29T12:34:56.78Z \
        2026-07-10T12:34:56.789Z; do
        OPENCLAW_BUILD_TIMESTAMP="$value" openclaw_resolve_build_timestamp
        printf '\n'
      done
      for value in \
        2026-00-01T00:00:00Z \
        2026-02-29T00:00:00Z \
        2100-02-29T00:00:00Z \
        2026-04-31T00:00:00Z \
        2026-01-01T24:00:00Z \
        2026-01-01T00:60:00Z \
        2026-01-01T00:00:60Z \
        2026-01-01T00:00:00+00:00; do
        if OPENCLAW_BUILD_TIMESTAMP="$value" openclaw_resolve_build_timestamp >/dev/null 2>&1; then
          exit 1
        fi
      done
      unset OPENCLAW_BUILD_TIMESTAMP
      generated="$(openclaw_resolve_build_timestamp)"
      [[ "$generated" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$ ]]
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "0000-01-01T00:00:00.000Z",
        "2000-02-29T23:59:59.700Z",
        "2024-02-29T12:34:56.780Z",
        "2026-07-10T12:34:56.789Z",
        "",
      ].join("\n"),
    );
  });

  it("uses the shared build metadata policy for full commit and timestamp stamps", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/build-metadata.sh"');
    expect(script).toContain('BUILD_GIT_COMMIT="$(openclaw_resolve_git_commit "$ROOT_DIR")"');
    expect(script).toContain('BUILD_TS="$(openclaw_resolve_build_timestamp)"');
    expect(script).toContain('export OPENCLAW_BUILD_TIMESTAMP="$BUILD_TS"');
    expect(script).toContain('export GIT_COMMIT="$BUILD_GIT_COMMIT"');
    expect(script).not.toContain("git rev-parse --short HEAD");
  });

  it("gates only release packaging on clean matching source and verifies the embedded commit", () => {
    const script = readFileSync(scriptPath, "utf8");
    const sourceCheck = script.indexOf('bash "$ROOT_DIR/scripts/apple-release-source-check.sh"');
    const build = script.indexOf('cd "$ROOT_DIR/apps/macos"');
    const embeddedRead = script.indexOf(
      'plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit',
    );
    const signing = script.indexOf('"$ROOT_DIR/scripts/codesign-mac-app.sh"');
    const releaseBranch = script.lastIndexOf(
      'if [[ "$BUILD_CONFIG" == "release" ]]; then',
      sourceCheck,
    );
    const releaseBranchEnd = script.indexOf("\nfi", sourceCheck);

    expect(script).toContain('BUILD_CONFIG="${BUILD_CONFIG:-debug}"');
    expect(sourceCheck).toBeGreaterThan(releaseBranch);
    expect(sourceCheck).toBeLessThan(releaseBranchEnd);
    expect(sourceCheck).toBeLessThan(build);
    expect(script).toContain('--expected-commit "$BUILD_GIT_COMMIT"');
    expect(embeddedRead).toBeGreaterThan(sourceCheck);
    expect(embeddedRead).toBeLessThan(signing);
    expect(script).toContain("Release app embedded Git commit");
  });

  it("keeps dependency installation lockfile-safe", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installBlock = script.slice(
      script.indexOf('if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]'),
      script.indexOf('if [[ -z "${APP_BUILD:-}" ]]'),
    );

    expect(installBlock).toContain("run_pnpm install --frozen-lockfile");
    expect(installBlock).toContain("--config.node-linker=hoisted");
    expect(installBlock).not.toContain("--no-frozen-lockfile");
  });

  it("builds and bundles the MLX TTS helper for every requested architecture", () => {
    const script = readFileSync(scriptPath, "utf8");
    const buildLoop = script.slice(
      script.indexOf('for arch in "${BUILD_ARCHS[@]}"; do'),
      script.indexOf('BIN_PRIMARY="$(bin_for_arch "$PRIMARY_ARCH")"'),
    );
    const helperCopy = script.slice(
      script.indexOf('echo "🚚 Copying MLX TTS helper"'),
      script.indexOf("SPARKLE_FRAMEWORK_PRIMARY="),
    );

    expect(buildLoop).toContain('swift build --package-path "$MLX_TTS_HELPER_ROOT"');
    expect(buildLoop).toContain('--product "$MLX_TTS_HELPER_PRODUCT"');
    expect(buildLoop).toContain('--arch "$arch"');
    expect(helperCopy).toContain(
      'cp "$(helper_bin_for_arch "$PRIMARY_ARCH")" "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"',
    );
    expect(helperCopy).toContain('/usr/bin/lipo -create "${HELPER_BIN_INPUTS[@]}"');
    expect(helperCopy).toContain('chmod +x "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"');
  });

  it("falls back to corepack pnpm when the pnpm shim is absent", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = tempDirs.make("openclaw-package-pnpm-root-");
    const toolsDir = tempDirs.make("openclaw-package-pnpm-tools-");
    const logPath = path.join(tempRoot, "corepack.log");

    const corepackPath = path.join(toolsDir, "corepack");
    writeFileSync(
      corepackPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf \'%s|%s\\n\' "$PWD" "$*" >> "$OPENCLAW_TEST_LOG"',
        'if [[ "${1:-}" == "pnpm" && "${2:-}" == "--version" ]]; then',
        "  echo '11.2.2'",
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(corepackPath, 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_TEST_LOG=${JSON.stringify(logPath)}
      export OPENCLAW_TEST_LOG
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      run_pnpm install --frozen-lockfile --config.node-linker=hoisted
      run_pnpm build
    `);

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `${tempRoot}|pnpm --version`,
      `${tempRoot}|pnpm install --frozen-lockfile --config.node-linker=hoisted`,
      `${tempRoot}|pnpm build`,
    ]);
  });

  it("prefers repo Corepack pnpm over a global pnpm shim", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = tempDirs.make("openclaw-package-pnpm-root-");
    const outerRoot = tempDirs.make("openclaw-package-pnpm-outer-");
    const toolsDir = tempDirs.make("openclaw-package-pnpm-tools-");
    const logPath = path.join(tempRoot, "pnpm.log");

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
      run_pnpm --version
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("11.2.2\n");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `corepack|${tempRoot}|pnpm --version`,
      `corepack|${tempRoot}|pnpm --version`,
    ]);
  });

  it("fails with an actionable error when neither pnpm nor corepack pnpm is available", () => {
    const helperBlock = getPackageManagerHelperBlock();
    const tempRoot = tempDirs.make("openclaw-package-pnpm-root-");
    const toolsDir = tempDirs.make("openclaw-package-pnpm-tools-");

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      run_pnpm build
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm is not on PATH and corepack pnpm is unavailable");
  });

  it("checks the selected Swift toolchain before dependency install work", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installIndex = script.indexOf('if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]');
    const preInstallBlock = script.slice(0, installIndex);

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/swift-toolchain.sh"');
    expect(preInstallBlock).toContain("\nrequire_swift_toolchain\n");
  });

  it("fails with an actionable error when Swift tools are too old", () => {
    const helperBlock = getSwiftToolchainBlock();
    const toolsDir = tempDirs.make("openclaw-package-swift-tools-");

    const swiftPath = path.join(toolsDir, "swift");
    writeFileSync(
      swiftPath,
      [
        "#!/usr/bin/env bash",
        "echo 'swift-driver version: 1.115.1 Apple Swift version 6.0.3 (swiftlang-6.0.3.1.10 clang-1600.0.30.1)'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(swiftPath, 0o755);

    const result = runHelper(`
      set -euo pipefail
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      require_swift_toolchain
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Swift tools 6.2+");
    expect(result.stderr).toContain("Current Swift is 6.0");
  });

  it("accepts Swift tools 6.2 or newer", () => {
    const helperBlock = getSwiftToolchainBlock();
    const toolsDir = tempDirs.make("openclaw-package-swift-tools-");

    const swiftPath = path.join(toolsDir, "swift");
    writeFileSync(
      swiftPath,
      [
        "#!/usr/bin/env bash",
        "echo 'swift-driver version: 1.120.0 Apple Swift version 6.2.1 (swiftlang-6.2.1 clang-1700.0.13.5)'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(swiftPath, 0o755);

    const result = runHelper(`
      set -euo pipefail
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      ${helperBlock}
      require_swift_toolchain
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("runs Sparkle build metadata derivation from the repository root", () => {
    const helperBlock = getSparkleBuildHelperBlock();
    const tempRoot = tempDirs.make("openclaw-package-sparkle-root-");
    const toolsDir = tempDirs.make("openclaw-package-sparkle-tools-");

    const nodePath = path.join(toolsDir, "node");
    writeFileSync(
      nodePath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$PWD" != "$OPENCLAW_ROOT" ]]; then',
        '  echo "node ran outside repo root: $PWD" >&2',
        "  exit 1",
        "fi",
        "echo 2026060290",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(nodePath, 0o755);

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      OPENCLAW_ROOT=${JSON.stringify(tempRoot)}
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      export OPENCLAW_ROOT PATH
      cd /tmp
      ${helperBlock}
      sparkle_canonical_build_from_version 2026.6.2
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026060290\n");
    expect(result.stderr).toBe("");
  });

  it("does not kill unrelated OpenClaw processes during packaging", () => {
    const script = readFileSync(scriptPath, "utf8");
    const stopBlock = script.slice(
      script.indexOf("running_packaged_app_pids()"),
      script.indexOf('echo "🔏 Signing bundle'),
    );

    expect(script).not.toContain("killall -q OpenClaw");
    expect(stopBlock).toContain('local app_binary="$APP_ROOT/Contents/MacOS/OpenClaw"');
    expect(stopBlock).toContain('pgrep -x "$PRODUCT"');
    expect(stopBlock).toContain('grep -Fx "$app_binary"');
    expect(stopBlock).toContain(
      '[[ "$command_line" == "$app_binary" || "$command_line" == "$app_binary "* ]]',
    );
  });

  it("fails when the packaged app survives forced shutdown", () => {
    const result = runStopPackagedAppHarness(0);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Packaged OpenClaw bundle did not exit: 123");
  });

  it("fails release packaging when the Swift compatibility library is missing", () => {
    const result = runSwiftCompatibilityHarness("release");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Swift compatibility library not found");
  });

  it("allows debug packaging to continue without the Swift compatibility library", () => {
    const result = runSwiftCompatibilityHarness("debug");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("WARN: Swift compatibility library not found");
  });

  it("passes when the packaged app exits after shutdown", () => {
    const result = runStopPackagedAppHarness(1);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps mac packaging script checks in the macOS CI lane", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const macosCi = pkg.scripts?.["test:macos:ci"] ?? "";

    expect(macosCi).toContain("test/scripts/package-mac-app.test.ts");
    expect(macosCi).toContain("test/scripts/package-mac-dist.test.ts");
    expect(macosCi).toContain("test/scripts/create-dmg.test.ts");
    expect(macosCi).toContain("test/scripts/codesign-mac-app.test.ts");
    expect(macosCi).toContain("test/scripts/notarize-mac-artifact.test.ts");
  });

  it("fails closed when required Swift resources are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const openClawKitBlock = script.slice(
      script.indexOf(
        'OPENCLAWKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/OpenClawKit_OpenClawKit.bundle"',
      ),
      script.indexOf('echo "⌨️  Copying KeyboardShortcuts resources"'),
    );
    const keyboardShortcutsBlock = script.slice(
      script.indexOf('echo "⌨️  Copying KeyboardShortcuts resources"'),
      script.indexOf("running_packaged_app_pids()"),
    );

    expect(script).toContain(
      'node --import tsx "$ROOT_DIR/scripts/apple-app-i18n.ts" compile-macos',
    );
    expect(script).toContain('--output "$APP_ROOT/Contents/Resources"');
    expect(openClawKitBlock).toContain("ERROR: OpenClawKit resource bundle not found");
    expect(openClawKitBlock).toContain("exit 1");
    expect(openClawKitBlock).not.toContain("WARN:");
    expect(openClawKitBlock).not.toContain("continuing");
    expect(keyboardShortcutsBlock).toContain("KeyboardShortcuts_KeyboardShortcuts.bundle");
    expect(keyboardShortcutsBlock).toContain(
      'cp -R "$KEYBOARD_SHORTCUTS_BUNDLE" "$APP_ROOT/Contents/Resources/KeyboardShortcuts_KeyboardShortcuts.bundle"',
    );
    expect(keyboardShortcutsBlock).toContain("ERROR: KeyboardShortcuts resource bundle not found");
    expect(keyboardShortcutsBlock).toContain("exit 1");
    expect(keyboardShortcutsBlock).not.toContain("WARN:");
    expect(keyboardShortcutsBlock).not.toContain("continuing");
    expect(script).not.toContain("Textual resource bundle");
    expect(script).not.toContain("ALLOW_MISSING_TEXTUAL_BUNDLE");
  });

  it("preserves locked Swift package resolution before building", () => {
    const script = readFileSync(scriptPath, "utf8");
    const resolveCall =
      'run_with_locked_swift_packages swift package --scratch-path "$BUILD_PATH" resolve';
    const buildCall =
      'run_with_locked_swift_packages swift build -c "$BUILD_CONFIG" --product "$PRODUCT"';

    expect(script).toContain('resolved_file="$ROOT_DIR/apps/macos/Package.resolved"');
    expect(script).toContain('cmp -s "$resolved_snapshot" "$resolved_file"');
    expect(script).toContain('cp "$resolved_snapshot" "$resolved_file"');
    expect(script).toContain("ERROR: Swift package resolution changed Package.resolved");
    expect(script).toContain(resolveCall);
    expect(script).toContain(buildCall);
    expect(script.indexOf(resolveCall)).toBeLessThan(script.indexOf(buildCall));
  });

  it("restores and rejects a Swift package resolution that changes the lockfile", () => {
    const { result, resolvedFile } = runSwiftPackageResolutionHarness(true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: Swift package resolution changed Package.resolved");
    expect(readFileSync(resolvedFile, "utf8")).toBe("locked\n");
  });

  it("accepts a Swift package resolution that preserves the lockfile", () => {
    const { result, resolvedFile } = runSwiftPackageResolutionHarness(false);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(resolvedFile, "utf8")).toBe("locked\n");
  });

  it("embeds the canonical CLI installer as a signed app resource", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('INSTALL_CLI_SRC="$ROOT_DIR/scripts/install-cli.sh"');
    expect(script).toContain('cp "$INSTALL_CLI_SRC" "$APP_ROOT/Contents/Resources/install-cli.sh"');
    expect(script).toContain('chmod 0644 "$APP_ROOT/Contents/Resources/install-cli.sh"');
    expect(script.indexOf("Copying CLI installer")).toBeLessThan(
      script.indexOf('echo "🔏 Signing bundle'),
    );
  });

  it("embeds provider vectors as signed app resources", () => {
    const script = readFileSync(scriptPath, "utf8");
    const packageManifest = readFileSync("apps/macos/Package.swift", "utf8");

    expect(packageManifest).toContain('.copy("Resources/ProviderIcons")');
    expect(
      readFileSync(
        "apps/macos/Sources/OpenClaw/Resources/ProviderIcons/ProviderIcon-claude.svg",
        "utf8",
      ),
    ).toContain("<svg");
    expect(
      readFileSync(
        "apps/macos/Sources/OpenClaw/Resources/ProviderIcons/ProviderIcon-codex.svg",
        "utf8",
      ),
    ).toContain("<svg");
    expect(script).toContain(
      'PROVIDER_ICONS_SRC="$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/ProviderIcons"',
    );
    expect(script).toContain(
      'echo "ERROR: Provider icon resources missing at $PROVIDER_ICONS_SRC"',
    );
    expect(script).toContain(
      'cp -R "$PROVIDER_ICONS_SRC" "$APP_ROOT/Contents/Resources/ProviderIcons"',
    );
    expect(script.indexOf("Copying provider icon resources")).toBeLessThan(
      script.indexOf('echo "🔏 Signing bundle'),
    );
  });

  it("does not mask required Info.plist stamp failures", () => {
    const script = readFileSync(scriptPath, "utf8");
    const stampBlock = script.slice(
      script.indexOf("plist_set_string_required"),
      script.indexOf('echo "🚚 Copying binary"'),
    );

    expect(stampBlock).toContain("plist_set_string_required");
    expect(stampBlock).not.toContain("|| true");
  });

  it.runIf(process.platform === "darwin")(
    "sets required strings and fails when the plist cannot be stamped",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_set_string_required ${JSON.stringify(plist)} CFBundleIdentifier 'ai.openclaw.test'
        /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ${JSON.stringify(plist)}
        broken="$(mktemp -d)"
        plist_set_string_required "$broken" CFBundleIdentifier broken
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ai.openclaw.test");
      expect(result.stderr).toContain("Error Reading File");
    },
  );

  it.runIf(process.platform === "darwin")("adds optional strings and booleans", () => {
    const plist = makePlist();
    const result = runHelper(`
      set -euo pipefail
      source scripts/lib/plistbuddy.sh
      plist_set_or_add_string ${JSON.stringify(plist)} SUFeedURL ''
      plist_set_or_add_string ${JSON.stringify(plist)} SUPublicEDKey 'key"with\\\\slashes'
      plist_set_or_add_bool ${JSON.stringify(plist)} SUEnableAutomaticChecks false
      /usr/libexec/PlistBuddy -c 'Print :SUFeedURL' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUEnableAutomaticChecks' ${JSON.stringify(plist)}
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('key"with\\\\slashes');
    expect(result.stdout).toContain("false");
  });
});
