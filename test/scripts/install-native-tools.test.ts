import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const installers = [
  {
    script: "scripts/install-xcodegen.sh",
    url: "https://github.com/yonaskolb/XcodeGen/releases/download/2.45.4/xcodegen.zip",
  },
  {
    script: "scripts/install-swift-tools.sh",
    url: "https://github.com/nicklockwood/SwiftFormat/releases/download/0.62.1/swiftformat.zip",
  },
] as const;

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
    writeFileSync(
      curlPath,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$@" >"$OPENCLAW_TEST_CURL_ARGS_PATH"',
        "exit 28",
        "",
      ].join("\n"),
    );
    chmodSync(curlPath, 0o755);

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
});
