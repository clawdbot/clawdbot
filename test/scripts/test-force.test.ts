// Test Force tests cover test force script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runTestForce(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/test-force.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/test-force.ts", () => {
  it("prints help without clearing ports or running tests", () => {
    const result = runTestForce("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/test-force.ts");
    expect(result.stdout).not.toContain("test:force - clearing gateway");
    expect(result.stdout).not.toContain("running pnpm test");
  });

  it("rejects unknown arguments before clearing ports or running tests", () => {
    const result = runTestForce("--bogus");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("Usage: node --import tsx scripts/test-force.ts");
    expect(result.stdout).not.toContain("test:force - clearing gateway");
    expect(result.stdout).not.toContain("running pnpm test");
  });
});
