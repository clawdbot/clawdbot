// Bench Web Fetch tests cover the offline benchmark CLI contract.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/bench-web-fetch.ts";

function runBenchWebFetch(...args: string[]) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FIRECRAWL_API_KEY: "test-firecrawl-key-that-should-be-ignored",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stderr, stdout }));
    },
  );
}

describe("web fetch benchmark script", () => {
  it.concurrent("accepts the package-manager separator documented for pnpm scripts", async () => {
    const result = await runBenchWebFetch(
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

  it.concurrent("rejects duplicate singular flags without a stack trace", async () => {
    const result = await runBenchWebFetch("--runs", "1", "--runs", "2");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs was provided more than once");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it.concurrent.each([
    ["--runs", "1e3", "--runs must be a positive integer"],
    ["--warmup", "1e3", "--warmup must be a non-negative integer"],
    ["--runs", "9007199254740993", "--runs must be a positive integer"],
    ["--warmup", "9007199254740993", "--warmup must be a non-negative integer"],
  ])("rejects invalid benchmark count %s %s", async (flag, value, expectedError) => {
    const result = await runBenchWebFetch(flag, value);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(expectedError);
    expect(result.stderr).not.toContain("\n    at ");
  });
});
