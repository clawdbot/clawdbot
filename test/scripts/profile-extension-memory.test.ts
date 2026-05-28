import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runProfileExtensionMemory(args: string[]) {
  return spawnSync(process.execPath, ["scripts/profile-extension-memory.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/profile-extension-memory", () => {
  it("prints help without requiring built plugin artifacts", () => {
    const result = runProfileExtensionMemory(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/profile-extension-memory.mjs");
  });

  it("rejects loose numeric flags before scanning built plugin artifacts", () => {
    const cases = [
      ["--concurrency", "2abc"],
      ["--timeout-ms", "1e3"],
      ["--combined-timeout-ms", "90000ms"],
      ["--top", "0x10"],
    ];

    for (const [flag, value] of cases) {
      const result = runProfileExtensionMemory([flag, value]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`[extension-memory] ${flag} must be a positive integer`);
      expect(result.stderr).not.toContain("dist/extensions");
      expect(result.stderr).not.toContain("at ");
    }
  });
});
