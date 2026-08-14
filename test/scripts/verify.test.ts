// Verify tests cover verify script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runVerify(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/verify.mts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/verify", () => {
  it("prints help without running verify stages", () => {
    const result = runVerify("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/verify.mts");
    expect(result.stdout).not.toContain("CRABBOX_PHASE:");
    expect(result.stdout).not.toContain("[verify]");
  });

  it("rejects unknown args before running verify stages", () => {
    for (const args of [["--bogus"], ["bogus", "--help"]]) {
      const result = runVerify(...args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`unknown argument: ${args[0]}`);
      expect(result.stderr).toContain("Usage: node --import tsx scripts/verify.mts");
      expect(result.stderr).not.toContain("CRABBOX_PHASE:");
      expect(result.stderr).not.toContain("[verify]");
    }
  });
});
