// Bench Web Fetch tests cover the offline benchmark CLI contract.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/bench-web-fetch.ts";

function runBenchWebFetch(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      FIRECRAWL_API_KEY: "test-firecrawl-key-that-should-be-ignored",
      NODE_NO_WARNINGS: "1",
    },
  });
}

describe("web fetch benchmark script", () => {
  it("accepts the package-manager separator documented for pnpm scripts", () => {
    const result = runBenchWebFetch(
      "--",
      "--case",
      "tool-create",
      "--runs",
      "1",
      "--warmup",
      "0",
      "--json",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      cases: Array<{ id: string; samplesMs: number[] }>;
    };
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      id: "tool-create",
      samplesMs: expect.any(Array),
    });
    expect(report.cases[0]?.samplesMs).toHaveLength(1);
  });

  it("rejects duplicate singular flags without a stack trace", () => {
    const result = runBenchWebFetch("--runs", "1", "--runs", "2");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs was provided more than once");
    expect(result.stderr).not.toContain("\n    at ");
  });
});
