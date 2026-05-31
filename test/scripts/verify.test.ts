import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runVerify(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/verify.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/verify", () => {
  it("prints help without running verify stages", () => {
    const result = runVerify("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/verify.mjs");
    expect(result.stdout).not.toContain("CRABBOX_PHASE:");
    expect(result.stdout).not.toContain("[verify]");
  });

  it("rejects unknown args before running verify stages", () => {
    const result = runVerify("--bogus");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("Usage: node scripts/verify.mjs");
    expect(result.stderr).not.toContain("CRABBOX_PHASE:");
    expect(result.stderr).not.toContain("[verify]");
  });
});
