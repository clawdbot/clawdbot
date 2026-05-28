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
    const cases = [
      ["--iters", "1e3", "positive"],
      ["--batches", "2abc", "positive"],
      ["--max-rss-growth-mb", "0x10", "non-negative"],
      ["--max-tracked-retention", "abc", "non-negative"],
      ["--scope-bytes", "1mb", "positive"],
    ] as const;

    for (const [flag, value, label] of cases) {
      const snapDir = makeTempRoot();
      const result = runHarness(["--snap-dir", snapDir, flag, value, "--quiet"]);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${flag} must be a ${label} integer`);
      expect(readdirSync(snapDir)).toEqual([]);
    }
  });
});
