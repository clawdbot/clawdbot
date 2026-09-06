// Live-gated cache regression proof against stored provider baselines.
import { describe, expect, it } from "vitest";
import { LIVE_CACHE_TEST_ENABLED } from "./live-cache-test-support.js";
import { runLiveCacheRegression } from "./test-helpers/live-cache-regression-runner.js";

const describeCacheLive = LIVE_CACHE_TEST_ENABLED ? describe : describe.skip;

describeCacheLive("live cache regression", () => {
  it(
    "matches the stored provider cache baselines",
    async () => {
      const result = await runLiveCacheRegression();
      expect(result.regressions).toStrictEqual([]);
    },
    30 * 60_000,
  );
});
