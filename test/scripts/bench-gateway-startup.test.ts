import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("gateway startup benchmark script", () => {
  it("prints help without running benchmark cases", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-startup.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway startup benchmark");
    expect(result.stdout).toContain("--case <id>");
    expect(result.stdout).toContain("--cpu-prof-dir <dir>");
    expect(result.stdout).toContain("default (gateway default)");
    expect(result.stdout).not.toContain("[gateway-startup-bench]");
    expect(result.stderr).toBe("");
  });
});
