import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing as testApi } from "./session-cost-usage.test-support.js";

describe("session cost usage refresh backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testApi.clearUsageCostRefreshesForTest();
  });

  afterEach(() => {
    testApi.clearUsageCostRefreshesForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("doubles consecutive busy delays, caps them, and resets after success", async () => {
    let calls = 0;
    const refresh = vi
      .spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent")
      .mockImplementation(async () => {
        calls += 1;
        if (calls <= 10) {
          return "busy";
        }
        if (calls === 11) {
          testApi.requestCostUsageCacheRefresh({
            agentId: "backoff-test",
            sessionFiles: ["next-session.jsonl"],
          });
          return "refreshed";
        }
        if (calls === 12) {
          return "busy";
        }
        return "refreshed";
      });

    testApi.requestCostUsageCacheRefresh({ agentId: "backoff-test" });
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
    expect(refresh).toHaveBeenCalledTimes(12);

    await vi.advanceTimersByTimeAsync(49);
    expect(refresh).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(13);
  });

  it("queues a refresh with no scan target of its own, so late config decides the store", async () => {
    // The queued state used to snapshot a scan directory when it was created and
    // never refresh it, so a request that arrived before config pinned the default
    // store for every later run against that agent. Nothing but the merged config
    // may reach the runner.
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent").mockImplementation(
      async (params) => {
        calls.push({ ...params });
        return "refreshed";
      },
    );

    testApi.requestCostUsageCacheRefresh({ agentId: "merge-test" });
    testApi.requestCostUsageCacheRefresh({
      agentId: "merge-test",
      config: { session: { store: "/configured/my-store.json" } } as OpenClawConfig,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("sessionsDir");
    expect((calls[0]?.config as { session?: { store?: string } })?.session?.store).toBe(
      "/configured/my-store.json",
    );
  });
});
