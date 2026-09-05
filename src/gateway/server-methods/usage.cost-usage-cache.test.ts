import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";

const mocks = vi.hoisted(() => ({
  loadCostUsageSummaryFromCache: vi.fn(),
}));

function createSummary() {
  return {
    updatedAt: Date.now(),
    startDate: "2026-02-01",
    endDate: "2026-02-02",
    daily: [],
    totals: {
      totalTokens: 1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0,
    },
  };
}

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummaryFromCache: mocks.loadCostUsageSummaryFromCache,
  };
});

import { testApi } from "./usage.js";

describe("costUsageCache bounded growth", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    testApi.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.loadCostUsageSummaryFromCache.mockResolvedValue(createSummary());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testApi.costUsageCache.clear();
  });

  it("retains a stale refresh after its cache entry is replaced", async () => {
    const owner = new AsyncWorkScope();
    const replacementOwner = new AsyncWorkScope();
    const gate = createDeferredCore<ReturnType<typeof createSummary>>();
    const params = { startMs: 1, endMs: 2, agentId: "main", config: {} };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = await owner.track(() => testApi.loadCostUsageSummaryCached(params));
    clock.mockReturnValue(31_000);
    mocks.loadCostUsageSummaryFromCache.mockReturnValueOnce(gate.promise);
    let refresh: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    let drained = false;
    try {
      const stale = await owner.track(() => testApi.loadCostUsageSummaryCached(params));
      expect(stale).toEqual(first);
      // Keep the original producer joinable even against the broken owner on red.
      refresh = Array.from(testApi.costUsageCache.values())[0]?.inFlight;
      expect(refresh).toBeDefined();
      await replacementOwner.track(() =>
        testApi.loadCostUsageSummaryCached({ ...params, config: {} }),
      );
      await replacementOwner.drain();
      expect(mocks.loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(3);
      closing = owner.drain().then(() => {
        drained = true;
      });
      await nextTurn();
      expect(drained).toBe(false);
    } finally {
      gate.resolve(createSummary());
      await refresh;
      await closing;
      await Promise.all([owner.drain(), replacementOwner.drain()]);
    }
    expect(drained).toBe(true);
  });

  it("does not grow without bound when (startMs, endMs) varies across day rollover and range switches", async () => {
    const config = {
      agents: { entries: { main: { default: true } } },
    } as OpenClawConfig;

    // 600 distinct (startMs, endMs) pairs — larger than the 256 caps used by
    // the smallest sibling caches (RUN_LOOKUP_CACHE_LIMIT,
    // TRANSCRIPT_SESSION_KEY_CACHE_MAX) and small enough that the test runs
    // quickly.
    const ITERATIONS = 600;

    for (let i = 0; i < ITERATIONS; i++) {
      const startMs = Date.UTC(2026, 0, 1) + i * DAY_MS;
      const endMs = startMs + (i % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
      await testApi.loadCostUsageSummaryCached({ startMs, endMs, config });
    }

    // Primary: map must be bounded. Pre-fix this equals ITERATIONS (600).
    expect(testApi.costUsageCache.size).toBeLessThan(ITERATIONS);

    // Secondary: the most recent entry must still be present. FIFO evicts
    // oldest-first, never the newest.
    const lastStartMs = Date.UTC(2026, 0, 1) + (ITERATIONS - 1) * DAY_MS;
    const lastEndMs = lastStartMs + ((ITERATIONS - 1) % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
    const lastCacheKey = `agent:main:${lastStartMs}-${lastEndMs}:gateway`;
    expect(testApi.costUsageCache.has(lastCacheKey)).toBe(true);

    // Tertiary: the oldest entry must have been evicted once the cap was
    // exceeded. Pre-fix all 600 entries remain and this fails too.
    const firstStartMs = Date.UTC(2026, 0, 1);
    const firstEndMs = firstStartMs + DAY_MS - 1;
    const firstCacheKey = `agent:main:${firstStartMs}-${firstEndMs}:gateway`;
    expect(testApi.costUsageCache.has(firstCacheKey)).toBe(false);
  });

  it("evicts settled entries before in-flight entries when possible", async () => {
    const config = {
      agents: { entries: { main: { default: true } } },
    } as OpenClawConfig;
    const pending = createDeferredCore<ReturnType<typeof createSummary>>();
    mocks.loadCostUsageSummaryFromCache.mockReturnValueOnce(pending.promise);

    const inFlight = testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    let repeated: typeof inFlight | undefined;
    try {
      await Promise.resolve();
      for (let i = 0; i < 256; i++) {
        const startMs = Date.UTC(2026, 0, 1) + i * DAY_MS;
        await testApi.loadCostUsageSummaryCached({
          startMs,
          endMs: startMs + DAY_MS - 1,
          config,
        });
      }

      repeated = testApi.loadCostUsageSummaryCached({
        startMs: 1,
        endMs: 2,
        config,
      });
      await Promise.resolve();

      expect(testApi.costUsageCache.has("agent:main:1-2:gateway")).toBe(true);
      expect(mocks.loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(257);
    } finally {
      pending.resolve(createSummary());
      await Promise.all([inFlight, repeated]);
    }
  });
});
