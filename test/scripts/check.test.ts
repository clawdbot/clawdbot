// Check tests cover check script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PREFLIGHT_CHECKS, runCommand } from "../../scripts/check.mts";

describe("scripts/check", () => {
  function runCheck(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/check.mts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }

  it("prints help without running check stages", () => {
    const result = runCheck("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/check.mts");
    expect(result.stdout).not.toContain("[check]");
  });

  it("rejects unknown args before running check stages", () => {
    for (const args of [["--bogus"], ["bogus", "--help"]]) {
      const result = runCheck(...args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`unknown argument: ${args[0]}`);
      expect(result.stderr).toContain("Usage: node --import tsx scripts/check.mts");
      expect(result.stderr).not.toContain("[check]");
    }
  });

  it("runs pnpm commands through the managed child runner", async () => {
    const calls: Array<{ args: string[]; bin: string }> = [];
    const result = await runCommand(
      { args: ["lint"], name: "lint" },
      async (options: { args: string[]; bin: string }) => {
        calls.push(options);
        return 0;
      },
    );

    expect(calls).toEqual([{ args: ["lint"], bin: "pnpm" }]);
    expect(result).toMatchObject({ name: "lint", status: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the assertion safety ratchet in the aggregate preflight", () => {
    expect(PREFLIGHT_CHECKS).toContainEqual({
      name: "assertion SAFETY comment ratchet",
      args: ["check:assertion-safety"],
    });
  });
});
