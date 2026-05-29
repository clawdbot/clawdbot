import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/test-perf-budget.mjs";

describe("test perf budget script", () => {
  it("parses numeric budget env vars strictly before running Vitest", () => {
    expect(
      testing.parseArgs([], {
        OPENCLAW_TEST_PERF_BASELINE_WALL_MS: "1000",
        OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT: "12.5",
        OPENCLAW_TEST_PERF_MAX_WALL_MS: "1500",
      }),
    ).toMatchObject({
      baselineWallMs: 1000,
      maxRegressionPct: 12.5,
      maxWallMs: 1500,
    });

    expect(() =>
      testing.parseArgs([], {
        OPENCLAW_TEST_PERF_MAX_WALL_MS: "1000ms",
      }),
    ).toThrow("OPENCLAW_TEST_PERF_MAX_WALL_MS must be a non-negative number");
  });

  it("rejects malformed CLI budget values before running Vitest", () => {
    expect(testing.parseArgs(["--max-wall-ms", "1e3"], {})).toMatchObject({
      maxWallMs: 1000,
    });

    expect(() => testing.parseArgs(["--max-wall-ms", "1e3ms"], {})).toThrow(
      "--max-wall-ms must be a non-negative number",
    );
    expect(() => testing.parseArgs(["--max-regression-pct"], {})).toThrow(
      "--max-regression-pct requires a value",
    );
  });
});
