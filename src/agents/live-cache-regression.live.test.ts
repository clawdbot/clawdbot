import { describe, expect, it } from "vitest";
import { runLiveCacheRegression } from "./live-cache-regression-runner.js";
import { LIVE_CACHE_TEST_ENABLED } from "./live-cache-test-support.js";

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
