import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-cli-startup.ts";

describe("bench-cli-startup", () => {
  it("fails reports with no measured samples", () => {
    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "version",
            name: "--version",
            args: ["--version"],
            contract: null,
            samples: [],
            summary: {
              sampleCount: 0,
              durationMs: { avg: 0, p50: 0, p95: 0, min: 0, max: 0 },
              firstOutputMs: null,
              maxRssMb: null,
              exitSummary: "",
            },
          },
        ],
      }),
    ).toEqual(["openclaw.mjs version: no measured samples"]);
  });

  it("fails reports with nonzero or signaled CLI samples", () => {
    const passingSample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 0,
      signal: null,
    };

    expect(
      testing.collectFailedSamples({
        entry: "dist/entry.js",
        cases: [
          {
            id: "gatewayStatusJson",
            name: "gateway status --json",
            args: ["gateway", "status", "--json"],
            contract: null,
            samples: [
              passingSample,
              { ...passingSample, exitCode: 1 },
              { ...passingSample, exitCode: null, signal: "SIGTERM" },
            ],
            summary: {
              sampleCount: 3,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:0x1, code:1x1, signal:SIGTERMx1",
            },
          },
        ],
      }),
    ).toEqual([
      "dist/entry.js gatewayStatusJson sample 2: exited with code 1",
      "dist/entry.js gatewayStatusJson sample 3: exited via signal SIGTERM",
    ]);
  });

  it("allows declared nonzero exit codes for clean-state probes", () => {
    const sample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 1,
      signal: null,
      stderrTail: "Health check failed: gateway closed\n  Gateway target: ws://127.0.0.1:18789",
    };

    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "health",
            name: "health",
            args: ["health"],
            expectedExitCodes: [0, 1],
            expectedNonzeroOutputIncludes: ["Gateway target:"],
            contract: null,
            samples: [sample],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:1x1",
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects allowed nonzero exits without their expected clean-state output", () => {
    const sample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 1,
      signal: null,
      stderrTail: "TypeError: crashed before output",
    };

    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "health",
            name: "health",
            args: ["health"],
            expectedExitCodes: [0, 1],
            expectedNonzeroOutputIncludes: ["Gateway target:"],
            contract: null,
            samples: [sample],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:1x1",
            },
          },
        ],
      }),
    ).toEqual([
      "openclaw.mjs health sample 1: exited with expected code 1 but output did not match expected clean-state markers (Gateway target:)",
    ]);
  });

  it("rejects invalid measured run counts", () => {
    expect(() => testing.parsePositiveInt("0", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("2abc", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("1.5", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("1e3", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("0x10", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(testing.parsePositiveInt("1", 5)).toBe(1);
    expect(testing.parseNonNegativeInt("0", 1)).toBe(0);
    expect(() => testing.parseNonNegativeInt("-1", 1, "--warmup")).toThrow(
      "--warmup must be an integer >= 0",
    );
    expect(() => testing.parseNonNegativeInt("0b10", 1, "--warmup")).toThrow(
      "--warmup must be an integer >= 0",
    );
  });
});
