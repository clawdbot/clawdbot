import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";

vi.mock("./session-cost-usage-aggregation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cost-usage-aggregation.js")>()),
  refreshCostUsageCacheForAgent: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cost usage refresh backoff", () => {
  it("doubles consecutive busy delays, caps them, and resets after success", async () => {
    const root = tempDirs.make("openclaw-session-cost-backoff-");
    const sessionFile = path.join(root, "agents", "backoff-test", "sessions", "next-session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ message: { role: "user", content: "hello" } }),
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const params = { agentId: "backoff-test", startMs: 0, endMs: Date.now() };
      const refresh = vi.mocked(refreshCostUsageCacheForAgent);
      let queuedSubset: ReturnType<typeof loadSessionCostSummariesFromCache> | undefined;
      let calls = 0;
      refresh.mockImplementation(async () => {
        calls += 1;
        if (calls <= 10) {
          return "busy";
        }
        if (calls === 11) {
          queuedSubset = loadSessionCostSummariesFromCache({
            agentId: params.agentId,
            sessions: [{ sessionFile }],
          });
          await queuedSubset;
          return "refreshed";
        }
        if (calls === 12) {
          return "busy";
        }
        return "refreshed";
      });

      vi.useFakeTimers();
      try {
        expect(await loadCostUsageSummaryFromCache(params)).toMatchObject({
          cacheStatus: { status: "refreshing", pendingFiles: 1 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(1);

        for (const [delayMs, expectedCalls] of [
          [50, 2],
          [100, 3],
          [200, 4],
          [400, 5],
          [800, 6],
          [1_600, 7],
          [3_200, 8],
          [5_000, 9],
          [5_000, 10],
        ] as const) {
          await vi.advanceTimersByTimeAsync(delayMs - 1);
          expect(refresh).toHaveBeenCalledTimes(expectedCalls - 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(refresh).toHaveBeenCalledTimes(expectedCalls);
        }

        await vi.advanceTimersByTimeAsync(4_999);
        expect(refresh).toHaveBeenCalledTimes(10);
        await vi.advanceTimersByTimeAsync(1);
        // Join the subset's real filesystem lookup before advancing the retry clock.
        await queuedSubset;
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(12);
        expect(refresh.mock.calls[10]?.[0].sessionFiles).toBeUndefined();
        expect(refresh.mock.calls[11]?.[0].sessionFiles).toEqual([sessionFile]);

        await vi.advanceTimersByTimeAsync(49);
        expect(refresh).toHaveBeenCalledTimes(12);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(13);
        expect(vi.getTimerCount()).toBe(0);
        expect(
          await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
        ).toMatchObject({
          cacheStatus: { status: "stale" },
        });
      } finally {
        try {
          // Complete queued work even if an assertion failed before the final retry.
          refresh.mockResolvedValue("refreshed");
          await queuedSubset;
          await vi.runOnlyPendingTimersAsync();
          expect(
            await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false }),
          ).toMatchObject({
            cacheStatus: { status: "stale" },
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          refresh.mockReset();
          vi.useRealTimers();
        }
      }
    });
  });
});
