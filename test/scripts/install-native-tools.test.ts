import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const installers = [
  {
    script: "scripts/install-xcodegen.sh",
    url: "https://github.com/yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip",
  },
  {
    script: "scripts/install-swift-tools.sh",
    url: "https://github.com/nicklockwood/SwiftFormat/releases/download/0.62.1/swiftformat.zip",
  },
  {
    script: "scripts/install-periphery.sh",
    url: "https://github.com/peripheryapp/periphery/releases/download/3.8.0/periphery-3.8.0.zip",
  },
] as const;

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines, ""].join("\n"), {
    mode: 0o755,
  });
}

function makePeripheryFixture(version = "3.8.0") {
  const root = tempDirs.make("openclaw-periphery-installer-");
  const binDir = path.join(root, "bin");
  const bundleDir = path.join(root, "bundle");
  const installDir = path.join(root, "install directory");
  const archive = path.join(root, "periphery.zip");
  const callsPath = path.join(root, "periphery-calls.txt");
  mkdirSync(binDir);
  mkdirSync(bundleDir);
  writeExecutable(path.join(bundleDir, "periphery"), [
    'printf "%s\\n" "$0" "$@" >>"$OPENCLAW_TEST_PERIPHERY_CALLS"',
    '[[ "$#" -eq 1 && "$1" == "version" ]]',
    '[[ -f "$(dirname "$0")/libIndexStore.dylib" ]]',
    'printf "%s\\n" "$OPENCLAW_TEST_PERIPHERY_VERSION"',
  ]);
  writeFileSync(path.join(bundleDir, "libIndexStore.dylib"), "fixture index store\n");
  writeFileSync(path.join(bundleDir, "LICENSE.md"), "fixture license\n");
  const zip = spawnSync("zip", ["-q", archive, "periphery", "libIndexStore.dylib", "LICENSE.md"], {
    cwd: bundleDir,
    encoding: "utf8",
  });
  expect(zip.status, zip.stderr).toBe(0);
  writeExecutable(path.join(binDir, "curl"), [
    'while [[ "$#" -gt 0 ]]; do',
    '  case "$1" in',
    '    --output|-o) cp "$OPENCLAW_TEST_PERIPHERY_ARCHIVE" "$2"; exit 0 ;;',
    "  esac",
    "  shift",
    "done",
    "exit 64",
  ]);
  return {
    binDir,
    installDir,
    callsPath,
    run: () =>
      spawnSync("bash", ["scripts/install-periphery.sh", installDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_TEST_PERIPHERY_ARCHIVE: archive,
          OPENCLAW_TEST_PERIPHERY_CALLS: callsPath,
          OPENCLAW_TEST_PERIPHERY_VERSION: version,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: root,
        },
      }),
  };
}

function expectOption(args: string[], option: string, value: string): void {
  const index = args.indexOf(option);
  expect(index, `missing curl option ${option}`).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(value);
}

describe.runIf(process.platform !== "win32")("native tool installers", () => {
  it.each(installers)("bounds stalled downloads in $script", ({ script, url }) => {
    const root = tempDirs.make("openclaw-native-tool-installer-");
    const binDir = path.join(root, "bin");
    const argsPath = path.join(root, "curl-args.txt");
    const curlPath = path.join(binDir, "curl");
    mkdirSync(binDir);
    writeExecutable(curlPath, ['printf "%s\\n" "$@" >"$OPENCLAW_TEST_CURL_ARGS_PATH"', "exit 28"]);

    const result = spawnSync("bash", [script, path.join(root, "install")], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_TEST_CURL_ARGS_PATH: argsPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(28);
    const args = readFileSync(argsPath, "utf8").trimEnd().split("\n");
    expectOption(args, "--connect-timeout", "10");
    expectOption(args, "--max-time", "120");
    expectOption(args, "--retry", "3");
    expectOption(args, "--retry-max-time", "120");
    expect(args).toContain(url);
  });

  it("rejects a Periphery archive with the wrong digest before extraction or execution", () => {
    const fixture = makePeripheryFixture();
    const unzipCalls = path.join(fixture.binDir, "unzip-calls.txt");
    writeExecutable(path.join(fixture.binDir, "unzip"), [
      'printf "%s\\n" "$@" >"$(dirname "$0")/unzip-calls.txt"',
      "exit 99",
    ]);

    // This ZIP is extractable, but its real SHA-256 is not the pinned release digest.
    const result = fixture.run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBeGreaterThan(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(unzipCalls)).toBe(false);
    expect(existsSync(fixture.callsPath)).toBe(false);
    expect(existsSync(path.join(fixture.installDir, "periphery"))).toBe(false);
  });

  it.each([
    { version: "3.8.0", exitCode: 0 },
    { version: "3.8.1", exitCode: 1 },
  ])(
    "installs the complete Periphery bundle and verifies version $version",
    ({ version, exitCode }) => {
      const fixture = makePeripheryFixture(version);
      // Substitute only the digest boundary; extraction, installation, and execution stay real.
      writeExecutable(path.join(fixture.binDir, "shasum"), [
        '[[ "$#" -eq 3 && "$1" == "-a" && "$2" == "256" ]]',
        'cmp "$3" "$OPENCLAW_TEST_PERIPHERY_ARCHIVE"',
        'printf "%s  %s\\n" "07d4e286e31dd79164df39097e0b59f533c94badbe18158464a455ea88a166d7" "$3"',
      ]);

      const result = fixture.run();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(readFileSync(path.join(fixture.installDir, "libIndexStore.dylib"), "utf8")).toBe(
        "fixture index store\n",
      );
      expect(readFileSync(path.join(fixture.installDir, "LICENSE.md"), "utf8")).toBe(
        "fixture license\n",
      );
      expect(readFileSync(fixture.callsPath, "utf8")).toBe(
        `${path.join(fixture.installDir, "periphery")}\nversion\n`,
      );
    },
  );
});
