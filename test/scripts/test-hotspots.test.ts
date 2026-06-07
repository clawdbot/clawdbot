// Test Hotspots tests cover hotspot report evidence validation.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function mkTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-test-hotspots-"));
  tempRoots.push(root);
  return root;
}

function runTestHotspots(args: string[]) {
  return spawnSync(process.execPath, ["scripts/test-hotspots.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("test-hotspots script", () => {
  it("rejects Vitest reports without timed file results", () => {
    const reportPath = join(mkTempRoot(), "empty-report.json");
    writeFileSync(reportPath, `${JSON.stringify({ testResults: [] })}\n`, "utf8");

    const result = runTestHotspots(["--report", reportPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Vitest JSON report contained no timed file results.");
  });
});
