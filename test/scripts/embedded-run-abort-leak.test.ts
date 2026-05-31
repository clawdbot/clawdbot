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
});
