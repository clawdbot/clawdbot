// Ios Pull Gateway Log tests cover ios pull gateway log script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/dev/ios-pull-gateway-log.sh";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ios-log-pull-"));
  tempDirs.push(root);
  return root;
}

function runWithFakeXcrun(
  root: string,
  fakeXcrunBody: string,
  destPath: string,
): ReturnType<typeof spawnSync> {
  const binDir = path.join(root, "bin");
  const xcrunPath = path.join(binDir, "xcrun");
  mkdirSync(binDir);
  writeFileSync(
    xcrunPath,
    ["#!/usr/bin/env bash", "set -euo pipefail", fakeXcrunBody, ""].join("\n"),
  );
  chmodSync(xcrunPath, 0o755);

  return spawnSync("bash", [scriptPath, "device-udid", "ai.openclaw.ios.dev", destPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/dev/ios-pull-gateway-log.sh", () => {
  it("fails when the copied gateway log is empty", () => {
    const root = makeTempDir();
    const destPath = path.join(root, "openclaw-gateway.log");
    const result = runWithFakeXcrun(
      root,
      'while [[ "$#" -gt 0 ]]; do if [[ "$1" == "--destination" ]]; then shift; : > "$1"; fi; shift || break; done',
      destPath,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Gateway log pull produced an empty file");
    expect(result.stdout).not.toContain("Pulled to:");
  });

  it("prints the pulled gateway log tail when the copied file has content", () => {
    const root = makeTempDir();
    const destPath = path.join(root, "openclaw-gateway.log");
    const result = runWithFakeXcrun(
      root,
      'while [[ "$#" -gt 0 ]]; do if [[ "$1" == "--destination" ]]; then shift; printf "gateway ready\\n" > "$1"; fi; shift || break; done',
      destPath,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Pulled to: ${destPath}`);
    expect(result.stdout).toContain("gateway ready");
  });
});
