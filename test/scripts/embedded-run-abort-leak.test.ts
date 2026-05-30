import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
  it("rejects loose numeric thresholds before writing heap snapshots", () => {
    const snapDir = makeTempRoot();
    const result = runHarness(["--snap-dir", snapDir, "--iters", "1e3", "--quiet"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: --iters must be a positive integer");
    expect(readdirSync(snapDir)).toEqual([]);
  });
});
