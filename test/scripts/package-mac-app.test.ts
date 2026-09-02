// Package Mac App tests cover package mac app script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/package-mac-app.sh";
const swiftScriptPath = "scripts/lib/mac-swift-build.sh";

describe.skipIf(process.platform === "win32" || availableParallelism() < 2)(
  "parallel macOS Swift build ownership",
  () => {
    it.each(["success", "failure", "wrong-source", "cancel", "cleanup-failure"])(
      "joins architecture workers and preserves assembly safety: %s",
      async (mode) => {
        const root = tempDirs.make("openclaw-swift-parallel-");
        const stage = path.join(root, "stage");
        const scripts = path.join(root, "scripts/lib");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(stage);
        const commit = "b".repeat(40);
        writeFileSync(
          path.join(scripts, "mac-swift-build.sh"),
          `#!/bin/bash
set -euo pipefail
exec "${process.execPath}" "${path.join(root, "worker.mjs")}" "$@"
`,
        );
        writeFileSync(
          path.join(root, "worker.mjs"),
          `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [operation, root, arch, config, jobs, commit, skip, work] = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const event = (value) => fs.appendFileSync(path.join(root, 'events'), value + '\\n');
if (operation === 'cleanup') {
  event('cleanup:' + arch);
  process.exit(mode === 'cleanup-failure' ? 55 : 0);
}
event('build:' + arch + ':' + jobs);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(root, 'pid-' + arch), String(child.pid));
const exited = new Promise(resolve => child.on('exit', resolve));
process.on('SIGTERM', async () => { child.kill(); await exited; event('stopped:' + arch); process.exit(143); });
fs.writeFileSync(path.join(root, 'ready-' + arch), 'ready');
const deadline = Date.now() + 5000;
while (!['arm64', 'x86_64'].every(a => fs.existsSync(path.join(root, 'ready-' + a)))) {
  if (Date.now() > deadline) throw new Error('architecture barrier did not open');
  await new Promise(resolve => setTimeout(resolve, 10));
}
event('barrier:' + arch);
if (mode === 'cancel' || (mode === 'failure' && arch === 'arm64')) await new Promise(() => {});
child.kill(); await exited;
if (mode === 'failure') process.exit(42);
fs.writeFileSync(path.join(work, 'peekaboo-commit'), mode === 'wrong-source' ? 'wrong' : commit);
`,
        );
        const script = readFileSync(scriptPath, "utf8");
        const cleanup = script.slice(
          script.indexOf("cleanup_package_build() {"),
          script.indexOf("PNPM_CMD=()"),
        );
        const build = script.slice(
          script.indexOf('echo "🔨 Building $PRODUCT'),
          script.indexOf('BIN_PRIMARY="$(bin_for_arch'),
        );
        // Exercise the real parent wait/signal/cleanup flow; only the heavy graph is a fixture.
        const launcher = `set -euo pipefail
ROOT_DIR=${JSON.stringify(root)}
APP_STAGE_DIR=${JSON.stringify(stage)}
SWIFT_BUILD_RESULTS=""
SWIFT_BUILD_PID=""
PRODUCT=OpenClaw
BUILD_CONFIG=release
PEEKABOO_LOCKED_SOURCE_COMMIT=${commit}
SKIP_MLX_TTS=0
BUILD_ARCHS=(arm64 x86_64)
node() { exec "${process.execPath}" ${JSON.stringify(path.resolve("scripts/build-mac-swift.mts"))} "\${@:2}"; }
${cleanup}
${build}
touch "$ROOT_DIR/assembled"
`;
        const child = spawn("/bin/bash", ["-c", launcher], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdout.resume();
        const closed = new Promise<number | null>((resolve) => {
          child.on("close", resolve);
        });
        if (mode === "cancel") {
          await expect
            .poll(
              () =>
                existsSync(path.join(root, "ready-arm64")) &&
                existsSync(path.join(root, "ready-x86_64")),
            )
            .toBe(true);
          child.kill("SIGTERM");
        }
        const code = await closed;
        expect(code, stderr).toBe(
          mode === "success" ? 0 : mode === "cancel" ? 143 : mode === "cleanup-failure" ? 2 : 1,
        );
        expect(existsSync(path.join(root, "assembled"))).toBe(mode === "success");
        expect(existsSync(stage)).toBe(mode === "cleanup-failure");
        const events = readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
        expect(events.filter((event) => event.startsWith("cleanup:")).toSorted()).toEqual([
          "cleanup:arm64",
          "cleanup:x86_64",
        ]);
        for (const arch of ["arm64", "x86_64"]) {
          const pid = Number(readFileSync(path.join(root, `pid-${arch}`), "utf8"));
          expect(() => process.kill(pid, 0)).toThrow();
          expect(
            existsSync(path.join(root, "apps/macos/.build", `.openclaw-package-${arch}.lock`)),
          ).toBe(mode === "cleanup-failure");
        }
      },
      15_000,
    );
  },
);

describe("packaged worker freshness", () => {
  it.skipIf(process.platform === "win32")(
    "keeps private app staging out of package contents and removes it after use",
    async () => {
      const root = tempDirs.make("openclaw-package-stage-");
      const dist = path.join(root, "dist");
      const output = tempDirs.make("openclaw-package-stage-output-");
      const previousApp = path.join(dist, "OpenClaw.app/Contents/MacOS/OpenClaw");
      const { files, packageManager, version } = JSON.parse(
        readFileSync("package.json", "utf8"),
      ) as {
        files: string[];
        packageManager: string;
        version: string;
      };
      mkdirSync(path.dirname(previousApp), { recursive: true });
      writeFileSync(previousApp, "previous signed app\n");
      writeFileSync(path.join(dist, "entry.js"), "export {};\n");
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version, packageManager, files }),
      );
      const script = readFileSync(scriptPath, "utf8");
      const allocationStart = script.indexOf("# pnpm build owns the Control UI");
      const allocationEnd = script.indexOf('echo "🔨 Building $PRODUCT', allocationStart);
      expect(allocationStart).toBeGreaterThanOrEqual(0);
      expect(allocationEnd).toBeGreaterThan(allocationStart);
      const allocated = spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -euo pipefail
ROOT_DIR="$1"
APP_DESTINATION="$ROOT_DIR/dist/OpenClaw.app"
${script.slice(allocationStart, allocationEnd)}
printf '%s' "$APP_STAGE_DIR"
`,
          "package-stage",
          root,
        ],
        {
          encoding: "utf8",
          env: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: path.join(root, "unavailable") },
        },
      );
      expect(allocated.status, allocated.stderr).toBe(0);
      const stage = allocated.stdout;
      const swiftResults = path.join(stage, "swift-builds");
      mkdirSync(path.join(swiftResults, "arm64"), { recursive: true });
      writeFileSync(path.join(swiftResults, "arm64/peekaboo-commit"), "private stage canary\n");
      writeFileSync(path.join(swiftResults, "cleanup-complete"), "verified\n");
      mkdirSync(path.join(stage, "OpenClaw.app/Contents/MacOS"), { recursive: true });
      writeFileSync(path.join(stage, "OpenClaw.app/Contents/MacOS/OpenClaw"), "candidate app\n");
      try {
        expect(statSync(stage).dev).toBe(statSync(dist).dev);
        expect(statSync(stage).mode & 0o777).toBe(0o700);
        const packed = spawnSync(
          "npm",
          ["pack", "--silent", "--ignore-scripts", "--offline", "--pack-destination", output],
          { cwd: root, encoding: "utf8", env: { HOME: root, PATH: process.env.PATH } },
        );
        expect(packed.status, packed.stderr).toBe(0);
        const entries: string[] = [];
        await tar.t({
          file: path.join(output, `openclaw-${version}.tgz`),
          onentry: (entry) => {
            if (entry.type !== "Directory") {
              entries.push(entry.path);
            }
          },
        });
        expect(entries.toSorted()).toEqual(["package/dist/entry.js", "package/package.json"]);
      } finally {
        const cleanup = script.slice(
          script.indexOf("cleanup_package_build() {"),
          script.indexOf("PNPM_CMD=()"),
        );
        const cleaned = spawnSync(
          "/bin/bash",
          [
            "-c",
            `set -euo pipefail
APP_STAGE_DIR="$1"
SWIFT_BUILD_RESULTS="$APP_STAGE_DIR/swift-builds"
SWIFT_BUILD_PID=""
${cleanup}
`,
            "package-stage-cleanup",
            stage,
          ],
          { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } },
        );
        expect(cleaned.status, cleaned.stderr).toBe(0);
        expect(existsSync(stage)).toBe(false);
        expect(readFileSync(previousApp, "utf8")).toBe("previous signed app\n");
      }
    },
  );

  it.each([
    "dist/OpenClaw.app",
    "dist/OpenClaw-proof.app",
    "dist/.openclaw-package.fixture/OpenClaw.app",
  ])("bounds expanded package exclusions to the app root %s", (app) => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    const exclusions = manifest.files
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => entry.slice(1));
    const entries = [app, `${app}/Contents`, `${app}/Contents/MacOS/OpenClaw`, "dist/entry.js"];
    // npm 12 expands files globs into individual ignore rules. Exclude the app
    // directory, which also excludes its contents, not every payload file separately.
    const matches = entries.filter((entry) =>
      exclusions.some((pattern) => minimatch(entry, pattern, { dot: true })),
    );
    expect(matches).toEqual([app]);
  });

  it("rebuilds dirty JavaScript even when the old SKIP_TSC shortcut is requested", () => {
    const root = tempDirs.make("openclaw-package-worker-freshness-");
    const script = readFileSync(scriptPath, "utf8");
    const start = script.indexOf('if [[ "${SKIP_TSC:-0}"');
    const end = script.indexOf('node - "$ROOT_DIR/dist/build-info.json"', start);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      set -euo pipefail
      run_pnpm() { printf '%s\\n' 'fresh dirty worker' > "$HOME/worker.js"; }
      ${script.slice(start, end)}
    `,
      ],
      { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", SKIP_TSC: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(root, "worker.js"))).toBe(true);
  });
});

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

function runHelper(script: string, shell = "bash") {
  return spawnSync(shell, ["-lc", script], {
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

function getMergeFrameworkMachOsBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("merge_framework_machos()");
  const end = script.indexOf('PEEKABOO_SOURCE_COMMIT="$(resolve_peekaboo_source_commit)"');

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

function runSwiftToolchainHarness(options: {
  swiftVersion: string;
  selectedDeveloperDir: "command-line-tools" | "custom-xcode" | "invalid" | "xcode";
  developerDirOverride?: "custom-xcode" | "invalid" | "xcode";
  xcodeVersion?: string;
  xcodebuildFailure?: string;
}) {
  const root = tempDirs.make("openclaw-package-swift-root-");
  const toolsDir = path.join(root, "tools");
  const commandLineToolsDir = path.join(root, "Library", "Developer", "CommandLineTools");
  const xcodeDeveloperDir = path.join(root, "Applications", "Xcode.app", "Contents", "Developer");
  const customXcodeDeveloperDir = path.join(root, "MountedToolchains", "CustomDeveloper");
  const invalidDeveloperDir = path.join(root, "InvalidDeveloper");
  const developerDirs = {
    "command-line-tools": commandLineToolsDir,
    "custom-xcode": customXcodeDeveloperDir,
    invalid: invalidDeveloperDir,
    xcode: xcodeDeveloperDir,
  } as const;
  const selectedDeveloperDir = developerDirs[options.selectedDeveloperDir];

  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(commandLineToolsDir, { recursive: true });
  for (const developerDir of [xcodeDeveloperDir, customXcodeDeveloperDir]) {
    const xcodebuild = path.join(developerDir, "usr", "bin", "xcodebuild");
    mkdirSync(path.dirname(xcodebuild), { recursive: true });
    writeFileSync(
      xcodebuild,
      [
        "#!/usr/bin/env bash",
        '[[ "$*" == "-version" ]] || exit 2',
        ...(options.xcodebuildFailure
          ? [`printf '%s\\n' ${JSON.stringify(options.xcodebuildFailure)} >&2`, "exit 1"]
          : [`echo ${JSON.stringify(`Xcode ${options.xcodeVersion ?? "26.4"}`)}`]),
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(xcodebuild, 0o755);
  }
  writeFileSync(
    path.join(toolsDir, "xcrun"),
    [
      "#!/usr/bin/env bash",
      '[[ "${1:-}" == "xcodebuild" && "${2:-}" == "-version" ]] || exit 2',
      'developer_dir="${DEVELOPER_DIR:-$MOCK_SELECTED_DEVELOPER_DIR}"',
      'xcodebuild="$developer_dir/usr/bin/xcodebuild"',
      'if [[ ! -x "$xcodebuild" ]]; then',
      '  echo "xcrun: error: unable to find utility xcodebuild" >&2',
      "  exit 1",
      "fi",
      'exec "$xcodebuild" "${@:2}"',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(toolsDir, "swift"),
    [
      "#!/usr/bin/env bash",
      `echo 'swift-driver version: 1.120.0 Apple Swift version ${options.swiftVersion} (swiftlang-${options.swiftVersion} clang-1700.0.13.5)'`,
      "",
    ].join("\n"),
    "utf8",
  );
  for (const tool of ["xcrun", "swift"]) {
    chmodSync(path.join(toolsDir, tool), 0o755);
  }

  const developerDirOverride = options.developerDirOverride
    ? `export DEVELOPER_DIR=${JSON.stringify(developerDirs[options.developerDirOverride])}`
    : "unset DEVELOPER_DIR";
  return runHelper(`
    set -euo pipefail
    PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
    export MOCK_SELECTED_DEVELOPER_DIR=${JSON.stringify(selectedDeveloperDir)}
    ${developerDirOverride}
    ${getSwiftToolchainBlock()}
    require_swift_toolchain
  `);
}

function getSparkleBuildHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("sparkle_canonical_build_from_version()");
  const end = script.indexOf('source "$ROOT_DIR/scripts/lib/mac-swift-build.sh"');

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getPeekabooSourceCommitHelperBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("resolve_peekaboo_source_commit() {");
  const end = script.indexOf("sparkle_canonical_build_from_version()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function runPeekabooSourceCommitHarness(packageResolved: string, expectedRevision?: string) {
  const root = tempDirs.make("openclaw-package-peekaboo-source-");
  const resolvedFile = path.join(root, "apps", "macos", "Package.resolved");
  mkdirSync(path.dirname(resolvedFile), { recursive: true });
  writeFileSync(resolvedFile, packageResolved, "utf8");

  return runHelper(`
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    ${expectedRevision ? `export OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT=${JSON.stringify(expectedRevision)}` : "unset OPENCLAW_EXPECTED_PEEKABOO_SOURCE_COMMIT"}
    ${getPeekabooSourceCommitHelperBlock()}
    resolve_peekaboo_source_commit
  `);
}

function getSourceProvenanceStampBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf(
    'plist_set_string_required "$APP_ROOT/Contents/Info.plist" OpenClawBuildTimestamp',
  );
  const end = script.indexOf(
    'plist_set_or_add_string "$APP_ROOT/Contents/Info.plist" SUFeedURL',
    start,
  );

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function runSourceProvenanceStampHarness(corruptKey?: string) {
  const openClawCommit = "a".repeat(40);
  const peekabooCommit = "b".repeat(40);
  const corruptCommit = "c".repeat(40);
  const result = runHelper(`
    set -euo pipefail
    stamped_openclaw=
    stamped_peekaboo=
    plist_set_string_required() {
      case "$2" in
        OpenClawGitCommit) stamped_openclaw="$3" ;;
        PeekabooSourceCommit) stamped_peekaboo="$3" ;;
      esac
    }
    plist_print_required() {
      local value
      case "$2" in
        OpenClawGitCommit) value="$stamped_openclaw" ;;
        PeekabooSourceCommit) value="$stamped_peekaboo" ;;
        *) return 1 ;;
      esac
      if [[ "$2" == ${JSON.stringify(corruptKey ?? "")} ]]; then
        value=${JSON.stringify(corruptCommit)}
      fi
      printf '%s' "$value"
    }
    APP_ROOT=/tmp/OpenClaw.app
    ROOT_DIR=/unused
    node() { echo fixture-build-id; }
    plist_set_or_add_string() { :; }
    BUILD_TS=2026-08-13T00:00:00.000Z
    BUILD_GIT_COMMIT=${JSON.stringify(openClawCommit)}
    PEEKABOO_SOURCE_COMMIT=${JSON.stringify(peekabooCommit)}
    BUILD_CONFIG=release
    ${getSourceProvenanceStampBlock()}
    printf '%s\n%s\n' "$stamped_openclaw" "$stamped_peekaboo"
  `);

  return { result, openClawCommit, peekabooCommit };
}

function getMLXTTSHelperBuildBlock(): string {
  const script = readFileSync(swiftScriptPath, "utf8");
  const start = script.indexOf("helper_build_path_for_arch() {");
  const end = script.indexOf("sparkle_framework_for_arch()", start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSwiftPackageResolutionBlock(): string {
  const script = readFileSync(swiftScriptPath, "utf8");
  const start = script.indexOf("run_with_locked_swift_packages()");
  const end = script.indexOf("build_swift_architecture() {");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  // The shared EXIT cleanup also needs the packager preamble's unallocated app stage.
  return `${script.slice(start, end)}\nBUILD_PATH="$ROOT_DIR/build"\nSWIFT_WORK_ROOT="$ROOT_DIR/work"\nmkdir -p "$SWIFT_WORK_ROOT"\n`;
}

function getCompiledPeekabooHelperBlock(): string {
  const script = readFileSync(swiftScriptPath, "utf8");
  const start = script.indexOf("compiled_peekaboo_commit() {");
  const end = script.indexOf("swiftpm_resource_sources()", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function runRealCompiledPeekabooHarness(
  mutation:
    | "assume-unchanged"
    | "corrupt-object"
    | "dirty-gitlink"
    | "export-subst"
    | "gitlink-sibling"
    | "ignored"
    | "nested-gitlink"
    | "none"
    | "replacement-ref"
    | "untracked",
  expectedOverride?: string,
) {
  const root = tempDirs.make(`openclaw-compiled-peekaboo-real-${mutation}-`);
  const buildPath = path.join(root, "build");
  const checkout = path.join(buildPath, "checkouts", "Peekaboo");
  const sourcePath = path.join(checkout, "Core", "Sources", "Fixture.swift");
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(path.join(checkout, "Package.swift"), "// swift-tools-version: 6.2\n", "utf8");
  writeFileSync(sourcePath, 'let fixture = "$Format:%H$"\n', "utf8");
  writeFileSync(path.join(checkout, ".gitattributes"), "Core/Sources/Fixture.swift export-subst\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  let head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  }).stdout.trim();

  if (
    mutation === "dirty-gitlink" ||
    mutation === "gitlink-sibling" ||
    mutation === "nested-gitlink"
  ) {
    const gitlinkPath = mutation === "gitlink-sibling" ? "Vendor" : "Dependencies/Vendor";
    const gitlinkCheckout = path.join(checkout, gitlinkPath);
    mkdirSync(gitlinkCheckout, { recursive: true });
    writeFileSync(path.join(gitlinkCheckout, "README.md"), "initialized submodule\n");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "submodule fixture"],
    ]) {
      const result = spawnSync("git", args, { cwd: gitlinkCheckout, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const gitlinkHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: gitlinkCheckout,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      path.join(checkout, ".gitmodules"),
      `[submodule "fixture"]\n\tpath = ${gitlinkPath}\n\turl = https://example.invalid/vendor.git\n`,
      "utf8",
    );
    const stagedModules = spawnSync("git", ["add", ".gitmodules"], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(stagedModules.status, stagedModules.stderr).toBe(0);
    const added = spawnSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${gitlinkHead},${gitlinkPath}`],
      { cwd: checkout, encoding: "utf8" },
    );
    expect(added.status, added.stderr).toBe(0);
    const committed = spawnSync("git", ["commit", "-qm", "gitlink"], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(committed.status, committed.stderr).toBe(0);
    head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).stdout.trim();
  }

  if (mutation === "assume-unchanged") {
    const hidden = spawnSync(
      "git",
      ["update-index", "--assume-unchanged", path.relative(checkout, sourcePath)],
      {
        cwd: checkout,
        encoding: "utf8",
      },
    );
    expect(hidden.status, hidden.stderr).toBe(0);
    writeFileSync(sourcePath, "let fixture = 2\n", "utf8");
  } else if (mutation === "corrupt-object") {
    const treeId = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: checkout,
      encoding: "utf8",
    }).stdout.trim();
    const objectPath = path.join(checkout, ".git", "objects", treeId.slice(0, 2), treeId.slice(2));
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, "corrupt object\n");
  } else if (mutation === "dirty-gitlink") {
    writeFileSync(path.join(checkout, "Dependencies", "Vendor", "README.md"), "dirty submodule\n");
  } else if (mutation === "export-subst") {
    writeFileSync(sourcePath, `let fixture = "${head}"\n`, "utf8");
  } else if (mutation === "gitlink-sibling") {
    const sibling = path.join(checkout, "Core", "Vendor", "Injected.swift");
    mkdirSync(path.dirname(sibling), { recursive: true });
    writeFileSync(sibling, "let injected = true\n", "utf8");
  } else if (mutation === "ignored") {
    writeFileSync(path.join(checkout, ".git", "info", "exclude"), "Hidden.swift\n", "utf8");
    writeFileSync(path.join(checkout, "Hidden.swift"), "let hidden = true\n", "utf8");
  } else if (mutation === "untracked") {
    writeFileSync(path.join(checkout, "Untracked.swift"), "let untracked = true\n", "utf8");
  } else if (mutation === "replacement-ref") {
    const approvedHead = head;
    writeFileSync(sourcePath, 'let fixture = "replacement"\n', "utf8");
    const committed = spawnSync("git", ["commit", "-qam", "replacement"], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(committed.status, committed.stderr).toBe(0);
    const replacementHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).stdout.trim();
    const replaced = spawnSync("git", ["replace", approvedHead, replacementHead], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(replaced.status, replaced.stderr).toBe(0);
    const detached = spawnSync("git", ["checkout", "-q", "--detach", approvedHead], {
      cwd: checkout,
      encoding: "utf8",
    });
    expect(detached.status, detached.stderr).toBe(0);
    writeFileSync(sourcePath, 'let fixture = "replacement"\n', "utf8");
    head = approvedHead;
  }

  return runHelper(`
    set -euo pipefail
    ${getCompiledPeekabooHelperBlock()}
    compiled_peekaboo_commit ${JSON.stringify(buildPath)} ${JSON.stringify(expectedOverride ?? head)}
  `);
}

function getStopPackagedAppBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf("running_packaged_app_pids()");
  const end = script.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]');

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

function getSwiftPMResourceBundleBlock(): string {
  const script = readFileSync(scriptPath, "utf8");
  const start = script.indexOf('echo "📦 Copying SwiftPM resource bundles"');
  const end = script.indexOf("running_packaged_app_pids()");

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

function getSwiftPMResourcePatchBlock(): string {
  const script = readFileSync(swiftScriptPath, "utf8");
  const start = script.indexOf("swiftpm_resource_sources()");
  const end = script.indexOf("cleanup_swift_architecture() {", start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return script.slice(start, end);
}

const swiftPMResourceBundles = [
  "GRDB_GRDB.bundle",
  "OpenClaw_OpenClaw.bundle",
  "OpenClawKit_OpenClawKit.bundle",
  "OpenClawKit_OpenClawChatUI.bundle",
  "KeyboardShortcuts_KeyboardShortcuts.bundle",
  "SwiftMath_SwiftMath.bundle",
] as const;

const mlxTTSResourceFiles = [
  "mlx-swift_Cmlx.bundle/Contents/Info.plist",
  "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib",
  "swift-crypto_Crypto.bundle/Contents/Info.plist",
  "swift-crypto_Crypto.bundle/Contents/Resources/PrivacyInfo.xcprivacy",
  "swift-transformers_Hub.bundle/Contents/Info.plist",
  "swift-transformers_Hub.bundle/Contents/Resources/gpt2_tokenizer_config.json",
  "swift-transformers_Hub.bundle/Contents/Resources/t5_tokenizer_config.json",
] as const;

function runSwiftPMResourceBundleHarness(
  options: { missingBundle?: string; missingMetallib?: boolean; skipMLXTTS?: boolean } = {},
) {
  const root = tempDirs.make("openclaw-package-resources-root-");
  const buildRoot = path.join(root, "build");
  const helperBuildRoot = path.join(root, "helper build");
  const appRoot = path.join(root, "OpenClaw.app");
  const buildProducts = path.join(buildRoot, "arm64", "debug");
  const helperBuildProducts = path.join(helperBuildRoot, "arm64", "out", "Products", "Debug");

  mkdirSync(path.join(appRoot, "Contents", "Resources"), { recursive: true });
  for (const bundle of swiftPMResourceBundles) {
    if (bundle === options.missingBundle) {
      continue;
    }
    const source = path.join(buildProducts, bundle);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "marker"), bundle, "utf8");
  }
  for (const file of mlxTTSResourceFiles) {
    if (
      file.startsWith(`${options.missingBundle}/`) ||
      (options.missingMetallib && file.endsWith("/default.metallib"))
    ) {
      continue;
    }
    const source = path.join(helperBuildProducts, file);
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, file, "utf8");
  }

  const result = runHelper(`
    set -euo pipefail
    BUILD_ROOT=${JSON.stringify(buildRoot)}
    MLX_TTS_HELPER_BUILD_ROOT=${JSON.stringify(helperBuildRoot)}
    APP_ROOT=${JSON.stringify(appRoot)}
    PRIMARY_ARCH=arm64
    BUILD_CONFIG=debug
    SKIP_MLX_TTS=${options.skipMLXTTS ? "1" : "0"}
    build_path_for_arch() {
      echo "$BUILD_ROOT/$1"
    }
    helper_build_path_for_arch() {
      echo "$MLX_TTS_HELPER_BUILD_ROOT/$1"
    }
    helper_products_for_arch() {
      [[ "$#" -eq 1 && "$1" == "$PRIMARY_ARCH" ]] || return 1
      printf '%s\\n' ${JSON.stringify(helperBuildProducts)}
    }
    ${getSwiftPMResourceBundleBlock()}
  `);

  return { appRoot, result };
}

function runSwiftPMResourcePatchHarness(failRestore = false) {
  const root = tempDirs.make("openclaw-package-resource-patch-");
  const buildPath = path.join(root, "build");
  const checkoutRoot = path.join(buildPath, "checkouts");
  const keyboardShortcuts = path.join(
    checkoutRoot,
    "KeyboardShortcuts/Sources/KeyboardShortcuts/Utilities.swift",
  );
  const swiftMathFont = path.join(
    checkoutRoot,
    "SwiftMath/Sources/SwiftMath/MathBundle/MathFont.swift",
  );
  const swiftMathLegacyFont = path.join(
    checkoutRoot,
    "SwiftMath/Sources/SwiftMath/MathRender/MTFont.swift",
  );
  const fixtures = new Map([
    [
      keyboardShortcuts,
      [
        "import Foundation",
        "extension String {",
        "  var localized: String {",
        "    NSLocalizedString(self, bundle: .module, comment: self)",
        "  }",
        "}",
        "",
        "extension Data {",
        "}",
        "",
      ].join("\n"),
    ],
    [
      swiftMathFont,
      [
        "import Foundation",
        "#if os(macOS)",
        "import AppKit",
        "#endif",
        "",
        "/// Now available for everyone to use",
        'let first = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")',
        'let second = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")',
        "",
      ].join("\n"),
    ],
    [
      swiftMathLegacyFont,
      'let font = Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")\n',
    ],
  ]);

  for (const [file, contents] of fixtures) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }

  const result = runHelper(`
    set -euo pipefail
    SWIFT_WORK_ROOT=${JSON.stringify(tempDirs.make("openclaw-resource-backups-"))}
    BUILD_PATH=${JSON.stringify(buildPath)}
    ${getSwiftPMResourcePatchBlock()}
    patch_swiftpm_resource_lookups ${JSON.stringify(buildPath)}
    grep -q keyboardShortcutsPackagedResources ${JSON.stringify(keyboardShortcuts)}
    test "$(grep -c swiftMathPackagedResources ${JSON.stringify(swiftMathFont)})" -eq 3
    grep -q swiftMathPackagedResources ${JSON.stringify(swiftMathLegacyFont)}
    ${failRestore ? "mv() { return 13; }" : ""}
    cleanup_status=0
    restore_swiftpm_resource_sources || cleanup_status=$?
    exit "$cleanup_status"
  `);

  return { fixtures, result };
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
    APP_DESTINATION=${JSON.stringify(appRoot)}
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
    const build = script.indexOf('node "$ROOT_DIR/scripts/build-mac-swift.mts"');
    const embeddedRead = script.indexOf(
      'plist_print_required "$APP_ROOT/Contents/Info.plist" OpenClawGitCommit',
    );
    const bridgeSourceRead = script.indexOf(
      'plist_print_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit',
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
    expect(bridgeSourceRead).toBeGreaterThan(sourceCheck);
    expect(bridgeSourceRead).toBeLessThan(signing);
    expect(script).toContain(
      'plist_set_string_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit "$PEEKABOO_SOURCE_COMMIT"',
    );
    expect(script).not.toContain(
      'plist_set_string_required "$APP_ROOT/Contents/Info.plist" PeekabooSourceCommit "$BUILD_GIT_COMMIT"',
    );
  });

  it("stamps and validates independent OpenClaw and Peekaboo source revisions", () => {
    const { result, openClawCommit, peekabooCommit } = runSourceProvenanceStampHarness();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${openClawCommit}\n${peekabooCommit}\n`);
    expect(result.stderr).toBe("");
  });

  it.each([
    { key: "OpenClawGitCommit", diagnostic: "Release app OpenClaw source mismatch" },
    { key: "PeekabooSourceCommit", diagnostic: "Release app Peekaboo source mismatch" },
  ])("fails release validation independently for a wrong $key", ({ key, diagnostic }) => {
    const { result } = runSourceProvenanceStampHarness(key);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("resolves the exact pinned Peekaboo source revision from Package.resolved", () => {
    const packageResolved = readFileSync("apps/macos/Package.resolved", "utf8");
    const parsed = JSON.parse(packageResolved) as {
      pins: Array<{ identity: string; state: { revision?: string } }>;
    };
    const expectedRevision = parsed.pins.find((pin) => pin.identity === "peekaboo")?.state.revision;
    const result = runPeekabooSourceCommitHarness(packageResolved);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expectedRevision);
    expect(result.stderr).toBe("");
  });

  it("requires the locked Peekaboo pin to match the requested elevation release source", () => {
    const requestedRevision = "b".repeat(40);
    const packageResolved = readFileSync("apps/macos/Package.resolved", "utf8");
    const parsed = JSON.parse(packageResolved) as {
      pins: Array<{ identity: string; state: { revision?: string } }>;
    };
    const pinnedRevision = parsed.pins.find((pin) => pin.identity === "peekaboo")?.state.revision;
    expect(pinnedRevision).toMatch(/^[0-9a-f]{40}$/);

    const matching = runPeekabooSourceCommitHarness(packageResolved, pinnedRevision!);
    expect(matching.status, matching.stderr).toBe(0);
    expect(matching.stdout).toBe(pinnedRevision);

    const mismatched = runPeekabooSourceCommitHarness(packageResolved, requestedRevision);
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("does not match requested release source");
  });

  it.each([
    {
      title: "is missing",
      packageResolved: '{"pins":[]}',
      diagnostic: "exactly one 'peekaboo' pin",
    },
    {
      title: "has a malformed revision",
      packageResolved:
        '{"pins":[{"identity":"peekaboo","state":{"revision":"A2FB16764A7D1C53BF696127C287BA32703F614F"}}]}',
      diagnostic: "40-character lowercase hexadecimal revision",
    },
    {
      title: "is invalid JSON",
      packageResolved: "not-json",
      diagnostic: "Could not parse Peekaboo source revision",
    },
  ])("fails closed when the Peekaboo package pin $title", ({ packageResolved, diagnostic }) => {
    const result = runPeekabooSourceCommitHarness(packageResolved);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("builds and bundles the MLX TTS helper for every requested architecture", () => {
    const script = readFileSync(scriptPath, "utf8");
    const buildLoop = readFileSync(swiftScriptPath, "utf8");
    const helperCopy = script.slice(
      script.indexOf('echo "🚚 Copying MLX TTS helper"'),
      script.indexOf("SPARKLE_FRAMEWORK_PRIMARY="),
    );

    expect(buildLoop).toContain('build_mlx_tts_helper "$arch"');
    expect(helperCopy).toContain(
      'cp "$(helper_bin_for_arch "$PRIMARY_ARCH")" "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"',
    );
    expect(helperCopy).toContain('/usr/bin/lipo -create "${HELPER_BIN_INPUTS[@]}"');
    expect(helperCopy).toContain('chmod +x "$APP_ROOT/Contents/MacOS/$MLX_TTS_HELPER_PRODUCT"');
  });

  it.runIf(process.platform === "darwin")(
    "merges framework Mach-O binaries when the checkout path contains glob metacharacters",
    () => {
      const root = tempDirs.make("openclaw-package-framework-[fixture]-");
      const primary = path.join(root, "Primary.framework");
      const secondary = path.join(root, "Secondary.framework");
      const destination = path.join(root, "Destination.framework");
      const relativeBinary = path.join("Versions", "A", "OpenClawFixture");

      for (const framework of [primary, secondary, destination]) {
        mkdirSync(path.dirname(path.join(framework, relativeBinary)), { recursive: true });
      }

      const fixtureBinary = "/bin/ls";
      const fixtureArchitectures = spawnSync("/usr/bin/lipo", ["-archs", fixtureBinary], {
        encoding: "utf8",
      })
        .stdout.trim()
        .split(/\s+/u);
      const [primaryArchitecture, secondaryArchitecture] = fixtureArchitectures;
      if (!primaryArchitecture || !secondaryArchitecture) {
        throw new Error(`${fixtureBinary} must contain at least two architectures`);
      }
      const primaryBinary = path.join(primary, relativeBinary);
      const secondaryBinary = path.join(secondary, relativeBinary);
      const destinationBinary = path.join(destination, relativeBinary);
      expect(
        spawnSync("/usr/bin/lipo", [
          "-thin",
          primaryArchitecture,
          fixtureBinary,
          "-output",
          primaryBinary,
        ]).status,
      ).toBe(0);
      expect(spawnSync("/bin/cp", [fixtureBinary, secondaryBinary]).status).toBe(0);
      writeFileSync(destinationBinary, readFileSync(primaryBinary));

      const result = runHelper(`
        set -euo pipefail
        ${getMergeFrameworkMachOsBlock()}
        merge_framework_machos ${JSON.stringify(primary)} ${JSON.stringify(destination)} ${JSON.stringify(secondary)}
        /usr/bin/lipo -info ${JSON.stringify(destinationBinary)}
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(primaryArchitecture);
      expect(result.stdout).toContain(secondaryArchitecture);
    },
  );

  it.each(["arm64", "x86_64"])(
    "builds and locates the MLX helper with SwiftBuild on %s without a legacy output alias",
    (arch) => {
      const tempRoot = tempDirs.make("openclaw-package-mlx-metal-");
      const metalPath = path.join(tempRoot, "metal");
      const invocationPath = path.join(tempRoot, "swift-args");
      const helperBuildRoot = path.join(tempRoot, "build");
      const helperBuildProducts = path.join(helperBuildRoot, arch, "out", "Products", "Release");
      mkdirSync(helperBuildProducts, { recursive: true });
      writeFileSync(path.join(helperBuildProducts, "openclaw-mlx-tts"), arch);
      writeFileSync(metalPath, "#!/bin/sh\nexit 1\n");
      chmodSync(metalPath, 0o755);

      const result = runHelper(`
      set -euo pipefail
      PATH=/usr/bin:/bin
      xcrun() {
        case "$*" in
          "--find swift") printf '%s\\n' ${JSON.stringify(path.join(tempRoot, "swift"))} ;;
          "metal --version") return 0 ;;
          *) return 1 ;;
        esac
      }
      swift() {
        printf '%s\\n' "$@" >> ${JSON.stringify(invocationPath)}
        printf '\\n' >> ${JSON.stringify(invocationPath)}
        for argument in "$@"; do
          if [[ "$argument" == "--show-bin-path" ]]; then
            printf '%s\\n' ${JSON.stringify(helperBuildProducts)}
          fi
        done
      }
      MLX_TTS_HELPER_ROOT=${JSON.stringify(path.join(tempRoot, "helper"))}
      MLX_TTS_HELPER_BUILD_ROOT=${JSON.stringify(helperBuildRoot)}
      MLX_TTS_HELPER_PRODUCT=openclaw-mlx-tts
      BUILD_CONFIG=release
      SWIFT_BUILD_JOBS=2
      SWIFT_BUILD_RESULTS=${JSON.stringify(tempRoot)}
      mkdir -p "$SWIFT_BUILD_RESULTS/${arch}"
      ${getMLXTTSHelperBuildBlock()}
      build_mlx_tts_helper ${arch}
      build_mlx_tts_helper ${arch} --show-bin-path > "$SWIFT_BUILD_RESULTS/${arch}/helper-products"
      swift() { echo unexpected-build >&2; return 99; }
      cat "$(helper_bin_for_arch ${arch})"
    `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(arch);
      const buildArgs = [
        "build",
        "--build-system",
        "swiftbuild",
        "--package-path",
        path.join(tempRoot, "helper"),
        "-c",
        "release",
        "--product",
        "openclaw-mlx-tts",
        "--build-path",
        path.join(helperBuildRoot, arch),
        "--arch",
        arch,
        "--jobs",
        "2",
      ];
      const invocations = readFileSync(invocationPath, "utf8")
        .trim()
        .split("\n\n")
        .map((call) => call.split("\n"));
      expect(invocations).toEqual([buildArgs, [...buildArgs, "--show-bin-path"]]);
    },
  );

  it("skips the MLX TTS helper build and copy when OPENCLAW_SKIP_MLX_TTS=1", () => {
    const script = readFileSync(scriptPath, "utf8") + readFileSync(swiftScriptPath, "utf8");

    // Both the per-arch build and the bundle copy are gated on the same flag so
    // a skipped build never tries to copy a helper binary that was not built.
    expect(script).toContain(
      'if [[ "$SKIP_MLX_TTS" == "1" ]]; then\n    echo "🔇 Skipping $MLX_TTS_HELPER_PRODUCT (OPENCLAW_SKIP_MLX_TTS=1)',
    );
    expect(script).toContain(
      'if [[ "$SKIP_MLX_TTS" == "1" ]]; then\n  echo "🔇 Skipping MLX TTS helper copy (OPENCLAW_SKIP_MLX_TTS=1)',
    );
  });

  it("refuses OPENCLAW_SKIP_MLX_TTS for release builds but allows it for dev builds", () => {
    const script = readFileSync(scriptPath, "utf8");

    // Run the real guard snippet from the script (not a copy) so the release
    // safety invariant stays coupled to source: release bundles must ship the
    // voice helper, which notarization later verifies.
    const guardStart = script.indexOf('SKIP_MLX_TTS="${OPENCLAW_SKIP_MLX_TTS:-0}"');
    const guardEnd = script.indexOf("BUILD_TS=", guardStart);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = script.slice(guardStart, guardEnd);

    const released = runHelper(
      `set -euo pipefail\nexport OPENCLAW_SKIP_MLX_TTS=1\nBUILD_CONFIG=release\n${guard}\necho reached-build`,
    );
    expect(released.status).toBe(1);
    expect(released.stderr).toContain("not allowed for release builds");
    expect(released.stdout).not.toContain("reached-build");

    const dev = runHelper(
      `set -euo pipefail\nexport OPENCLAW_SKIP_MLX_TTS=1\nBUILD_CONFIG=debug\n${guard}\necho reached-build`,
    );
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toContain("reached-build");
  });

  it("falls back to corepack pnpm when the pnpm shim is absent", () => {
    const script = readFileSync(scriptPath, "utf8");
    const installBlock = script.slice(
      script.indexOf('if [[ "${SKIP_PNPM_INSTALL:-0}" != "1" ]]'),
      script.indexOf('if [[ -z "${APP_BUILD:-}" ]]'),
    );
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
      SKIP_PNPM_INSTALL=0
      ${installBlock}
      run_pnpm build
    `);

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      `${tempRoot}|pnpm --version`,
      `${tempRoot}|pnpm install --frozen-lockfile`,
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
    // Hosts with a system corepack in /usr/bin (plus a cached pnpm) would satisfy
    // the detection this test needs to fail; an empty cache with network disabled
    // keeps "corepack pnpm is unavailable" true everywhere.
    const corepackHome = tempDirs.make("openclaw-package-corepack-home-");

    const result = runHelper(`
      set -euo pipefail
      ROOT_DIR=${JSON.stringify(tempRoot)}
      PATH=${JSON.stringify(`${toolsDir}:/usr/bin:/bin`)}
      export COREPACK_HOME=${JSON.stringify(corepackHome)}
      export COREPACK_ENABLE_NETWORK=0
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
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.0.3",
      selectedDeveloperDir: "xcode",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Swift tools 6.3+");
    expect(result.stderr).toContain("Current Swift is 6.0");
  });

  it("rejects Command Line Tools even when they provide Swift 6.3", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "command-line-tools",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a full Xcode developer directory");
    expect(result.stderr).toContain(
      "Command Line Tools do not include the required SwiftUI macro plugins",
    );
    expect(result.stderr).toContain(
      "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
    );
    expect(result.stderr).toContain("DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer");
  });

  it("accepts Swift 6.3 from a selected full Xcode developer directory", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "xcode",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects Xcode 26.3 even when it exposes a Swift 6.3 binary", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "xcode",
      xcodeVersion: "26.3",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw macOS app packaging requires Xcode 26.4+");
    expect(result.stderr).toContain("current Xcode is 26.3");
  });

  it("accepts newer major Xcode toolchains that satisfy the Swift floor", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.4.0",
      selectedDeveloperDir: "xcode",
      xcodeVersion: "27.0",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("honors DEVELOPER_DIR when the global selection is Command Line Tools", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "command-line-tools",
      developerDirOverride: "xcode",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("accepts usable full Xcode tooling from a custom developer directory", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "custom-xcode",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects an unusable selected developer directory", () => {
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "invalid",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a full Xcode developer directory");
  });

  it("preserves the native Xcode failure before generic selection guidance", () => {
    const diagnostic = "xcodebuild: error: SDK metadata is unavailable";
    const result = runSwiftToolchainHarness({
      swiftVersion: "6.3.1",
      selectedDeveloperDir: "xcode",
      xcodebuildFailure: diagnostic,
    });

    expect(result.status).toBe(1);
    const diagnosticIndex = result.stderr.indexOf(diagnostic);
    const guidanceIndex = result.stderr.indexOf(
      "ERROR: OpenClaw macOS app packaging requires a full Xcode developer directory",
    );
    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
    expect(guidanceIndex).toBeGreaterThan(diagnosticIndex);
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
    expect(stopBlock).toContain('local app_binary="$APP_DESTINATION/Contents/MacOS/OpenClaw"');
    expect(stopBlock).toContain('pgrep -x "$PRODUCT"');
    expect(stopBlock).toContain('grep -Fx "$app_binary"');
    expect(stopBlock).toContain(
      '[[ "$command_line" == "$app_binary" || "$command_line" == "$app_binary "* ]]',
    );
  });

  it.skipIf(process.platform === "win32").each(["configured", "unset"] as const)(
    "passes an explicit signing identity and honors %s TMPDIR during worker verification",
    (tempMode) => {
      const script = readFileSync(scriptPath, "utf8");
      const start = script.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]');
      expect(start).toBeGreaterThanOrEqual(0);
      const signingBlock = script.slice(start);
      const tempRoot = tempDirs.make("openclaw-package-signing-identity-");
      const scriptsDir = path.join(tempRoot, "scripts");
      const signerPath = path.join(scriptsDir, "codesign-mac-app.sh");
      const appStage = path.join(tempRoot, "stage");
      const appRoot = path.join(appStage, "OpenClaw.app");
      const callerHome = path.join(tempRoot, "caller-home");
      const callerTemp = path.join(tempRoot, "caller temp [*]");
      const eventsPath = path.join(tempRoot, "events");
      const observationsPath = path.join(tempRoot, "worker-scratch.jsonl");
      const identity = "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)";
      for (const directory of [scriptsDir, appRoot, callerHome, callerTemp]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(path.join(appRoot, "candidate"), "verified replacement");
      writeFileSync(
        signerPath,
        '#!/usr/bin/env bash\nset -euo pipefail\n[[ -d "$1" ]]\nprintf "identity=%s\\n" "${SIGN_IDENTITY-<unset>}"\nprintf "sign\\n" >> "${0%/*}/../events"\n',
      );
      chmodSync(signerPath, 0o755);
      for (const arch of ["arm64", "x86_64"]) {
        const node = path.join(appRoot, "Contents/Resources/node-worker", arch, "bin/node");
        mkdirSync(path.dirname(node), { recursive: true });
        writeFileSync(
          node,
          `#!/bin/bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
        );
        chmodSync(node, 0o755);
      }
      writeFileSync(
        path.join(scriptsDir, "verify-mac-node-worker.mjs"),
        `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-')));
try {
  fs.writeFileSync(path.join(scratch, 'created-by-worker'), 'scratch');
  fs.appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({ home: process.env.HOME, scratch, callerCanary: process.env.OPENCLAW_TEST_CALLER_CANARY ?? null }) + '\\n');
  fs.appendFileSync(${JSON.stringify(eventsPath)}, 'worker:' + path.basename(process.argv[2]) + '\\n');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
`,
      );

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      set -euo pipefail
      ROOT_DIR="$1"
      APP_STAGE_DIR="$ROOT_DIR/stage"
      APP_ROOT="$APP_STAGE_DIR/OpenClaw.app"
      APP_DESTINATION="$ROOT_DIR/OpenClaw.app"
      BUILD_ARCHS=(arm64 x86_64)
      source "$3"
      stop_packaged_app_if_running() { printf 'stop\\n' >> "$ROOT_DIR/events"; }
      codesign() {
        [[ "$1" == --verify && "$2" == --deep && "$3" == --strict && -d "$4" ]]
        printf 'verify\\n' >> "$ROOT_DIR/events"
      }
      SIGN_IDENTITY="$2"
      export SIGN_IDENTITY
      ${signingBlock}
      printf 'published\\n' >> "$ROOT_DIR/events"
    `,
          "package-signing",
          tempRoot,
          identity,
          path.resolve("scripts/lib/mac-app-bundle.sh"),
        ],
        {
          encoding: "utf8",
          env: {
            HOME: callerHome,
            PATH: "/usr/bin:/bin",
            OPENCLAW_TEST_CALLER_CANARY: "must-not-reach-worker",
            ...(tempMode === "configured" ? { TMPDIR: callerTemp } : {}),
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Signing bundle with explicit SIGN_IDENTITY");
      expect(result.stdout).toContain(`identity=${identity}`);
      expect(result.stderr).toBe("");
      expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
        "sign",
        "verify",
        "worker:arm64",
        "worker:x86_64",
        "verify",
        "stop",
        "published",
      ]);
      expect(readFileSync(path.join(tempRoot, "OpenClaw.app/candidate"), "utf8")).toBe(
        "verified replacement",
      );
      const observations = readFileSync(observationsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { home: string; scratch: string; callerCanary: null });
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        expect(observation.home).toBe(appStage);
        expect(observation.callerCanary).toBeNull();
        expect(path.dirname(observation.scratch)).toBe(
          realpathSync(tempMode === "configured" ? callerTemp : "/tmp"),
        );
        expect(existsSync(observation.scratch)).toBe(false);
      }
    },
  );

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
    const macosCi = [1, 2, 3].map((part) => pkg.scripts?.[`test:macos:ci:${part}`] ?? "").join(" ");

    expect(macosCi).toContain("src/gateway/worker-environments/workspace-rsync-path.test.ts");
    expect(macosCi).toContain("test/scripts/package-mac-app.test.ts");
    expect(macosCi).toContain("test/scripts/package-mac-dist.test.ts");
    expect(macosCi).toContain("test/scripts/create-dmg.test.ts");
    expect(macosCi).toContain("test/scripts/codesign-mac-app.test.ts");
    expect(macosCi).toContain("test/scripts/notarize-mac-artifact.test.ts");
    expect(macosCi).toContain("test/scripts/mac-elevation-host.test.ts");
    expect(macosCi).toContain("test/scripts/mac-elevation-artifact.test.ts");
  });

  it("copies complete main and MLX helper SwiftPM bundles into packaged app resources", () => {
    const { appRoot, result } = runSwiftPMResourceBundleHarness();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const bundle of swiftPMResourceBundles) {
      expect(
        readFileSync(path.join(appRoot, "Contents", "Resources", bundle, "marker"), "utf8"),
      ).toBe(bundle);
      expect(existsSync(path.join(appRoot, bundle))).toBe(false);
    }
    for (const file of mlxTTSResourceFiles) {
      expect(readFileSync(path.join(appRoot, "Contents", "Resources", file), "utf8")).toBe(file);
      expect(existsSync(path.join(appRoot, file))).toBe(false);
    }
  });

  it("routes dependency resource lookups into signed app resources and restores sources", () => {
    const { fixtures, result } = runSwiftPMResourcePatchHarness();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const [file, contents] of fixtures) {
      expect(readFileSync(file, "utf8")).toBe(contents);
      expect(existsSync(`${file}.openclaw-original`)).toBe(false);
    }
  });

  it("fails cleanup instead of deleting backups when resource restoration fails", () => {
    const { result } = runSwiftPMResourcePatchHarness(true);
    expect(result.status).not.toBe(0);
  });

  it("fails closed when any required SwiftPM resource bundle is missing", () => {
    for (const missingBundle of swiftPMResourceBundles) {
      const { result } = runSwiftPMResourceBundleHarness({ missingBundle });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ERROR: Required SwiftPM resource bundle not found at");
      expect(result.stderr).toContain(missingBundle);
    }
  });

  it.each(["bundle", "compiled shaders"])(
    "fails closed when the MLX helper %s is missing",
    (missing) => {
      const { result } = runSwiftPMResourceBundleHarness(
        missing === "bundle"
          ? { missingBundle: "mlx-swift_Cmlx.bundle" }
          : { missingMetallib: true },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib");
    },
  );

  it("omits incomplete MLX helper resources when the helper is skipped for a dev build", () => {
    const { appRoot, result } = runSwiftPMResourceBundleHarness({
      skipMLXTTS: true,
      missingMetallib: true,
    });

    expect(result.status, result.stderr).toBe(0);
    for (const bundle of swiftPMResourceBundles) {
      expect(
        readFileSync(path.join(appRoot, "Contents", "Resources", bundle, "marker"), "utf8"),
      ).toBe(bundle);
    }
    for (const file of mlxTTSResourceFiles) {
      expect(existsSync(path.join(appRoot, "Contents", "Resources", file))).toBe(false);
    }
  });

  it("compiles app localizations into signed resources", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'node --import tsx "$ROOT_DIR/scripts/apple-app-i18n.ts" compile-macos',
    );
    expect(script).toContain('--output "$APP_ROOT/Contents/Resources"');
  });

  it("preserves locked Swift resolution and verifies source around each native build", () => {
    const worker = readFileSync(swiftScriptPath, "utf8");
    const build = worker.indexOf('swift build -c "$BUILD_CONFIG" --jobs');
    expect(worker).toContain('chmod 0400 "$SWIFT_PACKAGE_LOCK_BASELINE"');
    expect(worker).toContain('cmp -s "$resolved_snapshot" "$resolved_file"');
    expect(worker).toContain('cp "$resolved_snapshot" "$resolved_file"');
    expect(worker).toContain("identity in result");
    expect(worker.lastIndexOf("verify_snapshot_swift_lock", build)).toBeGreaterThan(
      worker.indexOf("build_swift_architecture()"),
    );
    expect(worker.indexOf("verify_snapshot_swift_lock", build)).toBeGreaterThan(build);
    expect(worker).toContain(
      'cp "$ROOT_DIR/apps/macos-mlx-tts/Package.resolved" "$MLX_TTS_HELPER_ROOT/Package.resolved"',
    );
  });

  it.each([
    { operation: "create", exitCode: 1, reason: "No such file or directory", mounts: "empty" },
    { operation: "attach", exitCode: 73, reason: "Permission denied", mounts: "empty" },
    { operation: "none", exitCode: 0, reason: "", mounts: "empty" },
    { operation: "attach", exitCode: 73, reason: "Permission denied", mounts: "mounted" },
    { operation: "attach", exitCode: 73, reason: "Permission denied", mounts: "failed" },
  ])(
    "preserves Peekaboo snapshot diagnostics and cleanup: $operation / $mounts",
    ({ operation, exitCode, reason, mounts }) => {
      const root = tempDirs.make("openclaw-peekaboo-snapshot-fixture-");
      const buildPath = path.join(root, "build with spaces");
      const checkout = path.join(buildPath, "checkouts", "Peekaboo");
      const scratch = path.join(root, "temporary snapshots");
      const unrelated = path.join(scratch, "unrelated-snapshot", "marker");
      const operationsPath = path.join(root, "operations");
      const expectedCommit = "b".repeat(40);
      mkdirSync(checkout, { recursive: true });
      mkdirSync(path.dirname(unrelated), { recursive: true });
      writeFileSync(path.join(checkout, "source"), "source preserved\n");
      writeFileSync(unrelated, "unrelated snapshot preserved\n");
      const hdiutil = path.join(root, "hdiutil");
      writeFileSync(
        hdiutil,
        `#!/bin/bash
        set -euo pipefail
        printf '%s\\n' "$1" >> "$operations"
        printf '%s\\0' "$@" > "$fixture_root/$1.args"
        if [[ "$1" == create ]]; then
          image="\${@: -1}"
          printf '%s' "\${image%/*}" > "$fixture_root/snapshot-root"
          : > "$image"
        fi
        for arg in "$@"; do
          if [[ "$arg" == -quiet ]]; then
            exec 1>&- 2>&-
          fi
        done
        if [[ "$1" == ${JSON.stringify(operation)} ]]; then
          printf 'hdiutil: %s failed - %s\\n' "$1" ${JSON.stringify(reason)} >&2 || true
          exit ${exitCode}
        fi
        if [[ "$1" == detach && ${JSON.stringify(operation)} != none ]]; then
          exit 1
        fi
        printf 'hdiutil: %s completed\\n' "$1" || true
        exit 0
        `,
      );
      chmodSync(hdiutil, 0o755);
      const mountCommand = path.join(root, "mount");
      writeFileSync(
        mountCommand,
        `#!/bin/bash
printf 'mount\\n' >> "$operations"
${mounts === "failed" ? "exit 1" : mounts === "mounted" ? `printf '/dev/disk9 on %s/work/snapshot/mount (apfs, read-only)\\n' "$fixture_root"` : "exit 0"}
`,
      );
      chmodSync(mountCommand, 0o755);

      const result = runHelper(
        `
      set -euo pipefail
      export fixture_root=${JSON.stringify(root)}
      export operations=${JSON.stringify(operationsPath)}
      export PATH=${JSON.stringify(`${root}:/usr/bin:/bin`)}
      TMPDIR=${JSON.stringify(scratch)}
      ROOT_DIR=${JSON.stringify(root)}
      ${getSwiftPackageResolutionBlock()}
      trap cleanup_swift_architecture EXIT
      BUILD_PATH=${JSON.stringify(buildPath)}
      compiled_peekaboo_commit() {
        printf 'verify:%s:%s\\n' "$1" "$2" >> "$operations"
        printf '%s' "$2"
      }
      rm() {
        printf 'remove:%s\\n' "$*" >> "$operations"
        command rm "$@"
      }
      create_verified_peekaboo_snapshot ${JSON.stringify(buildPath)} ${JSON.stringify(expectedCommit)}
      printf 'snapshot-ready\\n' >> "$operations"
      `,
        "/bin/bash",
      );

      const snapshotRoot = readFileSync(path.join(root, "snapshot-root"), "utf8");
      const image = path.join(snapshotRoot, "Peekaboo.dmg");
      const mount = path.join(snapshotRoot, "mount");
      const expectedOperations = [`verify:${checkout}:${expectedCommit}`, "create"];
      if (operation !== "create") {
        expectedOperations.push("attach");
      }
      if (operation === "none") {
        expectedOperations.push(`verify:${mount}:${expectedCommit}`, "snapshot-ready");
      }
      expectedOperations.push("detach");
      if (operation !== "none") {
        expectedOperations.push("mount");
      }
      const retained = mounts !== "empty";
      if (!retained) {
        expectedOperations.push(
          `remove:-rf ${snapshotRoot}  ${path.join(root, "work/resource-backups")}`,
        );
      }
      expect(result.status).toBe(retained ? 1 : exitCode);
      expect(readFileSync(operationsPath, "utf8").trim().split("\n")).toEqual(expectedOperations);
      expect(existsSync(snapshotRoot)).toBe(retained);
      expect(readFileSync(path.join(checkout, "source"), "utf8")).toBe("source preserved\n");
      expect(readFileSync(unrelated, "utf8")).toBe("unrelated snapshot preserved\n");
      const readArgs = (command: string) =>
        readFileSync(path.join(root, `${command}.args`), "utf8")
          .split("\0")
          .slice(0, -1)
          .filter((arg) => arg !== "-quiet");
      expect(readArgs("create")).toEqual([
        "create",
        "-fs",
        "APFS",
        "-format",
        "UDRO",
        "-srcfolder",
        checkout,
        "-volname",
        "OpenClawPeekabooSnapshot",
        image,
      ]);
      if (operation !== "create") {
        expect(readArgs("attach")).toEqual([
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          mount,
          image,
        ]);
      }
      expect(readArgs("detach")).toEqual(["detach", mount]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        operation === "none" ? "" : `hdiutil: ${operation} failed - ${reason}\n`,
      );
    },
  );

  it("stamps only the clean Peekaboo source that SwiftPM actually compiled", () => {
    const verifier = getCompiledPeekabooHelperBlock();
    expect(verifier).toContain('"core.commitGraph=false"');
    expect(verifier).toContain('"--no-replace-objects"');
    expect(verifier).toContain('"fsck", "--full", "--strict"');
    expect(verifier).toContain('"cat-file", object_type');
    expect(readFileSync(swiftScriptPath, "utf8")).toContain(
      'swift package --scratch-path "$build_path" edit Peekaboo --path "$PEEKABOO_SNAPSHOT_MOUNT"',
    );
    const mismatched = runRealCompiledPeekabooHarness("none", "e".repeat(40));
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("does not match locked source");
  });

  // Each real Git fixture owns a separate checkout and deadline; do not aggregate
  // independent verification scenarios into one long synchronous test.
  it.each(["none", "nested-gitlink"] as const)(
    "accepts committed Peekaboo source (%s)",
    (mutation) => {
      const result = runRealCompiledPeekabooHarness(mutation);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    "assume-unchanged",
    "corrupt-object",
    "dirty-gitlink",
    "export-subst",
    "gitlink-sibling",
    "ignored",
    "replacement-ref",
    "untracked",
  ] as const)("rejects uncommitted Peekaboo source (%s)", (mutation) => {
    const result = runRealCompiledPeekabooHarness(mutation);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Compiled Peekaboo checkout does not exactly match its committed source",
    );
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

  it("stages the pinned universal CUA driver before nested-code signing", () => {
    const packageScript = readFileSync(scriptPath, "utf8");
    const stageScript = readFileSync("scripts/stage-cua-driver-macos.sh", "utf8");
    const codesignScript = readFileSync("scripts/codesign-mac-app.sh", "utf8");
    const cuaManifest = JSON.parse(
      readFileSync("extensions/cua-computer/package.json", "utf8"),
    ) as {
      dependencies: Record<string, string>;
      cuaDriverArtifacts: Record<string, { archiveSha256?: string }>;
    };

    expect(stageScript).toContain('TAG="cua-driver-rs-v${VERSION}"');
    expect(stageScript).toContain(
      'ARTIFACT_MANIFEST="$ROOT_DIR/extensions/cua-computer/package.json"',
    );
    expect(stageScript).toContain('manifest.dependencies["@trycua/cua-driver"]');
    expect(stageScript).toContain('manifest.cuaDriverArtifacts["darwin-universal-binary"]');
    expect(cuaManifest.dependencies["@trycua/cua-driver"]).toBe("0.22.0");
    expect(cuaManifest.cuaDriverArtifacts["darwin-universal-binary"]?.archiveSha256).toBe(
      "202eb9dd2185d64fc0599079671f50efe2bf71b300a85644cf26d627bb7355e6",
    );
    expect(packageScript).toContain(
      '"$ROOT_DIR/scripts/stage-cua-driver-macos.sh" "$APP_ROOT/Contents/Resources/cua-driver"',
    );
    expect(packageScript.indexOf("Staging embedded CUA driver")).toBeLessThan(
      packageScript.indexOf('echo "🔏 Signing bundle'),
    );
    expect(codesignScript).toContain(
      'echo "Signing embedded CUA driver"; sign_plain_item "$CUA_DRIVER"',
    );
  });

  it("omits the CUA driver only from elevation-host packages", () => {
    const packageScript = readFileSync(scriptPath, "utf8");
    const variantBlock = packageScript.slice(
      packageScript.indexOf('SIGNING_VARIANT="${OPENCLAW_MAC_SIGNING_VARIANT:-standard}"'),
      packageScript.indexOf("# OPENCLAW_SKIP_MLX_TTS"),
    );
    const cuaBlock = packageScript.slice(
      packageScript.indexOf('if [[ "$SIGNING_VARIANT" == "elevation-host" ]]'),
      packageScript.indexOf('echo "📦 Copying CLI installer"'),
    );

    expect(variantBlock).toContain("standard | elevation-host");
    expect(variantBlock).toContain("Unknown OPENCLAW_MAC_SIGNING_VARIANT value");
    expect(cuaBlock).toContain("Omitting embedded CUA driver from elevation-host package");
    expect(cuaBlock).toContain("else");
    expect(cuaBlock).toContain("Staging embedded CUA driver");
    expect(cuaBlock).toContain(
      '"$ROOT_DIR/scripts/stage-cua-driver-macos.sh" "$APP_ROOT/Contents/Resources/cua-driver"',
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
