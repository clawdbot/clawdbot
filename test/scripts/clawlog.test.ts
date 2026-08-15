// Clawlog tests cover argument parsing contracts in the macOS logging helper.
// These tests do not require a real macOS log(1) binary; they verify that the
// script reaches the expected code paths before any platform-specific command.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/clawlog.sh", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runClawlog(args: string[] = []) {
  const cwd = tempDirs.make("openclaw-clawlog-test-");
  const binDir = path.join(cwd, "bin");
  mkdirSync(binDir);
  const sudoPath = path.join(binDir, "sudo");
  writeFileSync(sudoPath, "#!/bin/sh\nexit 0\n");
  chmodSync(sudoPath, 0o755);

  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

describe("clawlog.sh argument parsing", () => {
  it("uses the documented default view when run without arguments", () => {
    const result = runClawlog();
    const output = result.stdout + result.stderr;

    // Should reach the default log-view path, not print usage.
    expect(output).toContain("Showing last 50 log lines from the past 5m");
    expect(output).not.toContain("USAGE:");
  });

  it("still prints usage for --help", () => {
    const result = runClawlog(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("USAGE:");
  });

  const valueOptions = ["-n", "-l", "-c", "-s", "-o"];
  for (const option of valueOptions) {
    it(`reports a clear error when ${option} is missing a value`, () => {
      const result = runClawlog([option]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Error: ${option} requires a value`);
    });
  }

  it("accepts dash-prefixed search text", () => {
    const result = runClawlog(["-s", "-failed"]);

    expect(result.stderr).not.toContain("requires a value");
  });

  it("accepts dash-prefixed category", () => {
    const result = runClawlog(["-c", "-ServerManager"]);

    expect(result.stderr).not.toContain("requires a value");
  });

  it("accepts dash-prefixed output path", () => {
    const result = runClawlog(["-o", "-debug.log"]);

    expect(result.stderr).not.toContain("requires a value");
  });
});
