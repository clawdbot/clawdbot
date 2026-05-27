import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("scripts/kova-ci-summary", () => {
  it("prints help without treating --help as a valued option", () => {
    const result = spawnSync(process.execPath, ["scripts/kova-ci-summary.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: node scripts/kova-ci-summary.mjs --report");
  });
});
