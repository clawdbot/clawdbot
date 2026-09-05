// Embedded Run Abort Leak tests cover embedded run abort leak script behavior.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function runHarness(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--expose-gc", "scripts/embedded-run-abort-leak.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("scripts/embedded-run-abort-leak", () => {
  it.each([
    [["--iters", "1e3"], "--iters must be a positive integer"],
    [["--iters", "0"], "--iters must be a positive integer"],
    [["--batches", "+1"], "--batches must be a positive integer"],
    [["--scope-bytes", "9007199254740992"], "--scope-bytes must be a positive integer"],
    [["--max-rss-growth-mb", "1.5"], "--max-rss-growth-mb must be a non-negative integer"],
    [
      ["--max-tracked-retention", "9007199254740992"],
      "--max-tracked-retention must be a non-negative integer",
    ],
    [["--iters", "1", "--iters", "2"], "--iters was provided more than once"],
    [["--iters", "1", "--iters"], "--iters was provided more than once"],
    [["--iters", "1", "--iters", "-h"], "--iters was provided more than once"],
    [["--iters", "  "], "--iters requires a value"],
    [["--iters", " -1 "], "--iters requires a value"],
    [["--iters", "-h"], "--iters requires a value"],
    [["--mode", "-h"], "--mode requires a value"],
  ])("rejects %j before writing heap snapshots", (args, message) => {
    const snapDir = tempRoots.make("openclaw-embedded-abort-leak-test-");
    const result = runHarness(["--snap-dir", snapDir, ...args]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`error: ${message}\n`);
    expect(readdirSync(snapDir)).toEqual([]);
  });

  it.each(["--quiet", "-h"])("rejects %s as a snapshot directory", (value) => {
    const result = runHarness(["--snap-dir", value]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error: --snap-dir requires a value\n");
  });

  it("accepts padded decimal controls and zero thresholds before help", () => {
    const result = runHarness([
      "--iters",
      " 01 ",
      "--batches",
      "01",
      "--scope-bytes",
      "9007199254740991",
      "--max-rss-growth-mb",
      " 0 ",
      "--max-tracked-retention",
      "00",
      "--help",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: node --import tsx --expose-gc");
  });
});
