import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  discoverAllSessions: vi.fn(),
  loadCombinedSessionStoreForGatewayCore: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayCore: mocks.loadCombinedSessionStoreForGatewayCore,
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: mocks.discoverAllSessions,
    loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
  };
});

import { testApi, usageHandlers } from "./usage.js";

const config = {
  agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
  session: {},
} as OpenClawConfig;

const baseParams = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function sessionSummary(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost: totalTokens / 1000,
    inputCost: totalTokens / 1000,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

async function runSessionsUsage(
  params: Record<string, unknown>,
  runtimeConfig: OpenClawConfig = config,
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage"],
    'usageHandlers["sessions.usage"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => runtimeConfig },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "sessions.usage result");
}

describe("sessions.usage result cache", () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.clearAllMocks();
    testApi.sessionsUsageCache.clear();
    mocks.loadCombinedSessionStoreForGatewayCore.mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });
    mocks.discoverAllSessions.mockImplementation(async (params: { agentId?: string }) => [
      {
        sessionId: `session-${params.agentId ?? "unknown"}`,
        sessionFile: `/tmp/${params.agentId ?? "unknown"}.jsonl`,
        mtime: 100,
      },
    ]);
    mocks.loadSessionCostSummariesFromCache.mockImplementation(
      async (params: { sessions: unknown[] }) => ({
        summaries: params.sessions.map(() => sessionSummary(10)),
        cacheStatus: {
          status: "fresh",
          cachedFiles: params.sessions.length,
          pendingFiles: 0,
          staleFiles: 0,
        },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a byte-identical cached response without repeating transcript aggregation", async () => {
    const first = await runSessionsUsage(baseParams);
    const repeated = await runSessionsUsage(baseParams);

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(mocks.discoverAllSessions).toHaveBeenCalledTimes(1);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(1);
  });

  it("does not share entries across result-shaping query parameters", async () => {
    const variants: Array<Record<string, unknown>> = [
      baseParams,
      { ...baseParams, agentId: "opus" },
      { ...baseParams, agentScope: "all" },
      { ...baseParams, startDate: "2026-02-02", endDate: "2026-02-03" },
      { ...baseParams, mode: "specific", utcOffset: "UTC+2" },
      { ...baseParams, limit: 1 },
      { ...baseParams, groupBy: "family" },
      { ...baseParams, includeContextWeight: true },
    ];

    for (const params of variants) {
      await runSessionsUsage(params);
    }

    expect(testApi.sessionsUsageCache.size).toBe(variants.length);
    // The all-agent variant discovers both configured agents and aggregates
    // each agent cache once; every other variant has one effective agent.
    expect(mocks.discoverAllSessions).toHaveBeenCalledTimes(variants.length + 1);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(variants.length + 1);

    const storeLoads = mocks.loadCombinedSessionStoreForGatewayCore.mock.calls.length;
    await runSessionsUsage({ ...baseParams, key: "agent:main:missing" });
    expect(testApi.sessionsUsageCache.size).toBe(variants.length + 1);
    expect(mocks.loadCombinedSessionStoreForGatewayCore).toHaveBeenCalledTimes(storeLoads + 1);
  });

  it("does not share entries across runtime config snapshots", async () => {
    const reloadedConfig = { ...config };

    await runSessionsUsage(baseParams, config);
    await runSessionsUsage(baseParams, reloadedConfig);

    expect(mocks.discoverAllSessions).toHaveBeenCalledTimes(2);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cold misses into one transcript aggregation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const aggregationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.loadSessionCostSummariesFromCache.mockImplementationOnce(
      async (params: { sessions: unknown[] }) => {
        started();
        await blocked;
        return {
          summaries: params.sessions.map(() => sessionSummary(10)),
          cacheStatus: {
            status: "fresh",
            cachedFiles: params.sessions.length,
            pendingFiles: 0,
            staleFiles: 0,
          },
        };
      },
    );

    const first = runSessionsUsage(baseParams);
    const second = runSessionsUsage(baseParams);
    await aggregationStarted;

    expect(mocks.discoverAllSessions).toHaveBeenCalledTimes(1);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(1);
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(JSON.stringify(secondResult)).toBe(JSON.stringify(firstResult));
  });

  it("does not give a partial lower-cache snapshot the 30s freshness TTL", async () => {
    mocks.loadSessionCostSummariesFromCache
      .mockResolvedValueOnce({
        summaries: [null],
        cacheStatus: {
          status: "refreshing",
          cachedFiles: 0,
          pendingFiles: 1,
          staleFiles: 1,
        },
      })
      .mockResolvedValueOnce({
        summaries: [sessionSummary(20)],
        cacheStatus: {
          status: "fresh",
          cachedFiles: 1,
          pendingFiles: 0,
          staleFiles: 0,
        },
      });

    const partial = (await runSessionsUsage(baseParams)) as {
      totals: { totalTokens: number };
    };
    const refreshed = (await runSessionsUsage(baseParams)) as {
      totals: { totalTokens: number };
    };

    expect(partial.totals.totalTokens).toBe(0);
    expect(refreshed.totals.totalTokens).toBe(20);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
  });

  it("preserves a complete stale result when a refresh is partial", async () => {
    const first = (await runSessionsUsage(baseParams)) as {
      totals: { totalTokens: number };
    };
    expect(first.totals.totalTokens).toBe(10);

    mocks.loadSessionCostSummariesFromCache.mockResolvedValueOnce({
      summaries: [null],
      cacheStatus: {
        status: "refreshing",
        cachedFiles: 0,
        pendingFiles: 1,
        staleFiles: 1,
      },
    });
    now = 31_000;
    await runSessionsUsage(baseParams);
    await vi.waitFor(() => {
      expect(
        Array.from(testApi.sessionsUsageCache.values()).every((entry) => !entry.inFlight),
      ).toBe(true);
    });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const aggregationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.loadSessionCostSummariesFromCache.mockImplementationOnce(
      async (params: { sessions: unknown[] }) => {
        started();
        await blocked;
        return {
          summaries: params.sessions.map(() => sessionSummary(20)),
          cacheStatus: {
            status: "fresh",
            cachedFiles: params.sessions.length,
            pendingFiles: 0,
            staleFiles: 0,
          },
        };
      },
    );

    let returned = false;
    const next = runSessionsUsage(baseParams).then((result) => {
      returned = true;
      return result as { totals: { totalTokens: number } };
    });
    await aggregationStarted;
    await Promise.resolve();
    expect(returned).toBe(true);
    expect((await next).totals.totalTokens).toBe(10);
    release();
    await vi.waitFor(() => {
      expect(
        Array.from(testApi.sessionsUsageCache.values()).every((entry) => !entry.inFlight),
      ).toBe(true);
    });
  });

  it("serves stale data while one 30s refresh replaces it", async () => {
    const first = await runSessionsUsage(baseParams);
    mocks.loadSessionCostSummariesFromCache.mockImplementationOnce(
      async (params: { sessions: unknown[] }) => ({
        summaries: params.sessions.map(() => sessionSummary(20)),
        cacheStatus: {
          status: "fresh",
          cachedFiles: params.sessions.length,
          pendingFiles: 0,
          staleFiles: 0,
        },
      }),
    );

    now = 31_000;
    const stale = await runSessionsUsage(baseParams);
    expect(JSON.stringify(stale)).toBe(JSON.stringify(first));
    await vi.waitFor(() => {
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
    });

    await vi.waitFor(async () => {
      const refreshed = (await runSessionsUsage(baseParams)) as {
        totals: { totalTokens: number };
      };
      expect(refreshed.totals.totalTokens).toBe(20);
    });
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
  });
});
