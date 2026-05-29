import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runBenchTestChanged(args: string[]) {
  return spawnSync(process.execPath, ["scripts/bench-test-changed.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("bench-test-changed script", () => {
  it("rejects malformed max worker values before inspecting git state", () => {
    const malformed = runBenchTestChanged(["--max-workers", "2abc"]);

    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("--max-workers must be a positive integer");
    expect(malformed.stderr).not.toContain("at ");

    const fractional = runBenchTestChanged(["--max-workers", "1.5"]);

    expect(fractional.status).toBe(1);
    expect(fractional.stdout).toBe("");
    expect(fractional.stderr).toContain("--max-workers must be a positive integer");
    expect(fractional.stderr).not.toContain("at ");
  });

  it("rejects missing max worker values before inspecting git state", () => {
    const result = runBenchTestChanged(["--max-workers"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--max-workers requires a value");
    expect(result.stderr).not.toContain("at ");
  });
});
