// Gateway concurrency benchmark tests cover CLI parsing and bounded percentile summaries.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-gateway-concurrency.ts";

describe("gateway concurrency benchmark script", () => {
  it("parses benchmark controls without booting a gateway", () => {
    expect(
      testing.parseOptions([
        "--concurrency",
        "12",
        "--runs",
        "2",
        "--warmup",
        "0",
        "--cadence-ms",
        "50",
        "--timeout-ms",
        "90000",
        "--output",
        "concurrency.json",
        "--json",
      ]),
    ).toMatchObject({
      cadenceMs: 50,
      concurrency: 12,
      json: true,
      output: "concurrency.json",
      runs: 2,
      timeoutMs: 90_000,
      warmup: 0,
    });
    expect(() => testing.parseOptions(["--concurrency", "65"])).toThrow(
      "--concurrency must be at most 64",
    );
    expect(() => testing.parseOptions(["--runs", "2", "--runs", "3"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("reports p50, p95, p99, and max with nearest-rank percentiles", () => {
    expect(testing.summarizeNumbers([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      max: 100,
      p50: 3,
      p95: 100,
      p99: 100,
    });
    expect(testing.summarizeNumbers([])).toBeNull();
  });

  it("ends CLI failures with the required wrapper marker", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-concurrency.ts", "--wat"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-gateway-concurrency] FAILED (exit 1)",
    );
  });
});
