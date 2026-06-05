// Check tests cover check script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../scripts/check.mjs";

describe("scripts/check", () => {
  function runCheck(...args: string[]) {
    return spawnSync(process.execPath, ["scripts/check.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }

  it("prints help without running check stages", () => {
    const result = runCheck("--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/check.mjs");
    expect(result.stdout).not.toContain("[check]");
  });

  it("rejects unknown args before running check stages", () => {
    const result = runCheck("--bogus");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("Usage: node scripts/check.mjs");
    expect(result.stderr).not.toContain("[check]");
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
});
