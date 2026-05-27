import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("scripts/qa-lab-up", () => {
  it("prints help before loading the Docker runtime", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/qa-lab-up.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 2_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: pnpm qa:lab:up");
  });
});
