// Embedded Run Abort Leak tests cover embedded run abort leak script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-embedded-abort-leak-test-"));
  tempRoots.push(root);
  return root;
}

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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scripts/embedded-run-abort-leak", () => {
  let looseThresholdProbe: {
    result: ReturnType<typeof runHarness>;
    snapDir: string;
  };

  beforeAll(() => {
    const snapDir = makeTempRoot();
    looseThresholdProbe = {
      result: runHarness(["--snap-dir", snapDir, "--iters", "1e3", "--quiet"]),
      snapDir,
    };
  });

  it("rejects loose numeric thresholds before writing heap snapshots", () => {
    expect(looseThresholdProbe.result.status).toBe(2);
    expect(looseThresholdProbe.result.stdout).toBe("");
    expect(looseThresholdProbe.result.stderr).toContain(
      "error: --iters must be a positive integer",
    );
    expect(readdirSync(looseThresholdProbe.snapDir)).toEqual([]);
  });

  it("rejects duplicate thresholds before writing heap snapshots", () => {
    const snapDir = makeTempRoot();
    const result = runHarness(["--snap-dir", snapDir, "--iters", "1", "--iters", "2", "--quiet"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: --iters was provided more than once");
    expect(readdirSync(snapDir)).toEqual([]);
  });

  it("rejects missing snapshot directories before writing heap snapshots", () => {
    const result = runHarness(["--snap-dir", "--quiet", "--iters", "1", "--batches", "1"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: --snap-dir requires a value");
  });

  it("rejects short flag values before writing heap snapshots", () => {
    const snapDirResult = runHarness(["--snap-dir", "-h", "--quiet", "--iters", "1"]);
    const itersResult = runHarness(["--iters", "-h", "--quiet"]);
    const modeResult = runHarness(["--mode", "-h", "--quiet"]);

    expect(snapDirResult.status).toBe(2);
    expect(snapDirResult.stdout).toBe("");
    expect(snapDirResult.stderr).toContain("error: --snap-dir requires a value");
    expect(itersResult.status).toBe(2);
    expect(itersResult.stdout).toBe("");
    expect(itersResult.stderr).toContain("error: --iters requires a value");
    expect(modeResult.status).toBe(2);
    expect(modeResult.stdout).toBe("");
    expect(modeResult.stderr).toContain("error: --mode requires a value");
  });
});
