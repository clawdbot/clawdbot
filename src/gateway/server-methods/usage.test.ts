/**
 * Tests for usage-report gateway methods and aggregation responses.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummaryFromCache: vi.fn(async () => ({
      updatedAt: Date.now(),
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      daily: [],
      totals: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    })),
    discoverAllSessions: vi.fn(async () => []),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
      agentIdBySessionKey: new Map(),
      durableTargets: [],
      storePath: "(multiple)",
      store: {},
    })),
  };
});

import {
  discoverAllSessions,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { testApi, usageHandlers } from "./usage.js";

describe("gateway usage helpers", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const costSummary = (params: { date?: string; totalTokens: number; totalCost: number }) => ({
    updatedAt: Date.now(),
    days: 1,
    daily: [
      {
        date: params.date ?? "2026-02-01",
        input: params.totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: params.totalTokens,
        totalCost: params.totalCost,
        inputCost: params.totalCost,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    ],
    totals: {
      input: params.totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: params.totalTokens,
      totalCost: params.totalCost,
      inputCost: params.totalCost,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
  });

  function expectUtcDateRange(
    result: ReturnType<typeof testApi.resolveDateRange>,
    startDate: string,
    endDate: string,
  ) {
    const range = expectDateRange(result);
    expect(range.startMs).toBe(Date.parse(`${startDate}T00:00:00.000Z`));
    expect(range.endMs).toBe(Date.parse(`${endDate}T00:00:00.000Z`) + dayMs - 1);
  }

  function expectDateRange(result: ReturnType<typeof testApi.resolveDateRange>) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value;
  }

  function withTimeZone<T>(timeZone: string, run: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  }

  beforeEach(() => {
    testApi.costUsageCache.clear();
    testApi.sessionsUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    [{ startDate: "2026-02-30" }, "invalid startDate"],
    [{ endDate: "2026-2-5" }, "invalid endDate"],
    [{ startDate: 0 }, "invalid startDate"],
    [{ endDate: [] }, "invalid endDate"],
    [{ startDate: "2026-02-01" }, "startDate and endDate must be provided together"],
    [{ endDate: "2026-02-01" }, "startDate and endDate must be provided together"],
    [{ startDate: "2026-02-01", endDate: "2026-13-01" }, "invalid endDate"],
    [{ startDate: "2026-02-03", endDate: "2026-02-02" }, "startDate must not be after endDate"],
  ])("resolveDateRange rejects invalid explicit ranges", (params, error) => {
    expect(testApi.resolveDateRange(params)).toEqual({
      ok: false,
      error: expect.stringContaining(error),
    });
  });

  it("usage.cost rejects an explicitly provided invalid date with INVALID_REQUEST", async () => {
    const respond = vi.fn();
    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { startDate: 0 },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(JSON.stringify(error)).toContain("startDate");
    // A rejected request must not query the cost loader for an unrelated range.
    expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
  });

  it.each(["usage.cost", "sessions.usage"] as const)(
    "%s rejects an invalid IANA timezone with INVALID_REQUEST",
    async (method) => {
      const respond = vi.fn();
      await expectDefined(
        usageHandlers[method],
        "usageHandlers[method] test invariant",
      )({
        respond,
        params: { mode: "specific", timeZone: "Invalid/Timezone" },
        context: { getRuntimeConfig: vi.fn(() => ({})) },
      } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(JSON.stringify(respond.mock.calls[0]?.[2])).toContain("invalid timeZone");
      expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
    },
  );

  it("falls back to the legacy offset when Gateway ICU does not recognize the browser timezone", async () => {
    const respond = vi.fn();
    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { mode: "specific", timeZone: "Newer/BrowserZone", utcOffset: "UTC+1" },
      context: { getRuntimeConfig: vi.fn(() => ({})) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 60 },
      }),
    );
  });

  it.each(["usage.cost", "sessions.usage"] as const)(
    "%s rejects startDate after endDate with INVALID_REQUEST",
    async (method) => {
      const respond = vi.fn();
      await expectDefined(
        usageHandlers[method],
        "usageHandlers[method] test invariant",
      )({
        respond,
        params: { startDate: "2026-02-03", endDate: "2026-02-02" },
        context: { getRuntimeConfig: vi.fn(() => ({})) },
      } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);

      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, payload, error] = expectDefined(
        respond.mock.calls[0],
        "respond.mock.calls[0] test invariant",
      );
      expect(ok).toBe(false);
      expect(payload).toBeUndefined();
      expect(JSON.stringify(error)).toContain("startDate must not be after endDate");
      expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["usage.cost", { startDate: "2026-02-01" }],
    ["usage.cost", { endDate: "2026-02-01" }],
    ["sessions.usage", { startDate: "2026-02-01" }],
    ["sessions.usage", { endDate: "2026-02-01" }],
  ] as const)("%s rejects an incomplete explicit date range", async (method, params) => {
    const respond = vi.fn();
    await expectDefined(
      usageHandlers[method],
      "usageHandlers[method] test invariant",
    )({
      respond,
      params,
      context: { getRuntimeConfig: vi.fn(() => ({})) },
    } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "startDate and endDate must be provided together"),
    );
    expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
    expect(vi.mocked(discoverAllSessions)).not.toHaveBeenCalled();
  });

  it("resolveDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const result = testApi.resolveDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
    });
    expectUtcDateRange(result, "2026-02-01", "2026-02-02");
  });

  it("resolveDateRange accepts a leap day in explicit UTC mode", () => {
    const result = testApi.resolveDateRange({
      startDate: "2024-02-29",
      endDate: "2024-03-01",
      mode: "utc",
    });
    expectUtcDateRange(result, "2024-02-29", "2024-03-01");
  });

  it.each([
    ["UTC+14:00", "2026-01-31T10:00:00.000Z", "2026-02-02T09:59:59.999Z"],
    ["UTC-12:00", "2026-02-01T12:00:00.000Z", "2026-02-03T11:59:59.999Z"],
    ["UTC+5:30", "2026-01-31T18:30:00.000Z", "2026-02-02T18:29:59.999Z"],
    ["UTC-0:30", "2026-02-01T00:30:00.000Z", "2026-02-03T00:29:59.999Z"],
    ["UTC+0", "2026-02-01T00:00:00.000Z", "2026-02-02T23:59:59.999Z"],
    ["UTC-0", "2026-02-01T00:00:00.000Z", "2026-02-02T23:59:59.999Z"],
  ])("resolveDateRange applies valid explicit UTC offset %s", (utcOffset, start, end) => {
    const range = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        mode: "specific",
        utcOffset,
      }),
    );
    expect(range.startMs).toBe(Date.parse(start));
    expect(range.endMs).toBe(Date.parse(end));
  });

  it.each(["UTC+2", "UTC+99", "UTC-12:01"])(
    "resolveDateRange gives IANA DST boundaries precedence over %s",
    (utcOffset) => {
      const range = expectDateRange(
        testApi.resolveDateRange({
          startDate: "2026-10-25",
          endDate: "2026-10-25",
          mode: "specific",
          timeZone: "Europe/Vienna",
          utcOffset,
        }),
      );
      expect(range.startMs).toBe(Date.UTC(2026, 9, 24, 22));
      expect(range.endMs).toBe(Date.UTC(2026, 9, 25, 23) - 1);
    },
  );

  it("resolveDateRange crosses a skipped IANA civil date for the prior day's end", () => {
    const range = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2011-12-29",
        endDate: "2011-12-29",
        mode: "specific",
        timeZone: "Pacific/Apia",
      }),
    );

    expect(range.startMs).toBe(Date.parse("2011-12-29T10:00:00.000Z"));
    expect(range.endMs).toBe(Date.parse("2011-12-30T10:00:00.000Z") - 1);
    expect(
      testApi.resolveDateRange({
        startDate: "2011-12-30",
        endDate: "2011-12-30",
        mode: "specific",
        timeZone: "Pacific/Apia",
      }),
    ).toEqual({
      ok: false,
      error: "calendar day does not exist in requested time zone",
    });
  });

  it.each([undefined, null, "", "  "])(
    "resolveDateRange retains UTC for omitted or blank offset %j",
    (utcOffset) => {
      expectUtcDateRange(
        testApi.resolveDateRange({
          startDate: "2026-02-01",
          endDate: "2026-02-02",
          mode: "specific",
          utcOffset,
        }),
        "2026-02-01",
        "2026-02-02",
      );
    },
  );

  it.each(["UTC+14:01", "UTC-12:01", "UTC+99", "UTC+5:60", "UTC+5.5", "bad", 330])(
    "resolveDateRange rejects malformed explicit UTC offset %j",
    (utcOffset) => {
      expect(
        testApi.resolveDateRange({
          startDate: "2026-02-01",
          endDate: "2026-02-02",
          mode: "specific",
          utcOffset,
        }),
      ).toEqual({
        ok: false,
        error: "invalid utcOffset: expected UTC-12:00 through UTC+14:00",
      });
    },
  );

  it.each(["usage.cost", "sessions.usage"] as const)(
    "%s rejects invalid explicit offsets before loading usage",
    async (method) => {
      for (const utcOffset of ["UTC+14:01", "UTC-12:01", "UTC+99"]) {
        const respond = vi.fn();
        await expectDefined(
          usageHandlers[method],
          "usage handler",
        )({
          respond,
          params: { mode: "specific", utcOffset },
          context: { getRuntimeConfig: () => ({}) },
        } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);
        expect(respond).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid utcOffset: expected UTC-12:00 through UTC+14:00",
          ),
        );
      }
      expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
      expect(vi.mocked(discoverAllSessions)).not.toHaveBeenCalled();
    },
  );

  it("resolveDateRange uses specific offset for today/day math after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
    const range = expectDateRange(
      testApi.resolveDateRange({
        days: 1,
        mode: "specific",
        utcOffset: "UTC-5",
      }),
    );
    expect(range.startMs).toBe(Date.UTC(2026, 1, 16, 5, 0, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 17, 4, 59, 59, 999));
  });

  it("resolveDateRange uses gateway local day boundaries in gateway mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const range = expectDateRange(testApi.resolveDateRange({ days: 1, mode: "gateway" }));
    const expectedStart = new Date(2026, 1, 5).getTime();
    expect(range.startMs).toBe(expectedStart);
    expect(range.endMs).toBe(expectedStart + dayMs - 1);
  });

  it("resolveDateRange uses gateway calendar end boundaries for explicit DST-short days", () => {
    withTimeZone("America/New_York", () => {
      const range = expectDateRange(
        testApi.resolveDateRange({
          startDate: "2026-03-08",
          endDate: "2026-03-08",
          mode: "gateway",
        }),
      );
      expect(range.startMs).toBe(new Date(2026, 2, 8).getTime());
      expect(range.endMs).toBe(new Date(2026, 2, 9).getTime() - 1);
    });
  });

  it("resolveDateRange keeps trailing gateway ranges on calendar days across DST", () => {
    withTimeZone("America/New_York", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
      const range = expectDateRange(
        testApi.resolveDateRange({
          days: 2,
          mode: "gateway",
        }),
      );
      expect(range.startMs).toBe(new Date(2026, 2, 8).getTime());
      expect(range.endMs).toBe(new Date(2026, 2, 10).getTime() - 1);
    });
  });

  it("resolveDateRange clamps days to its supported bounds and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = expectDateRange(testApi.resolveDateRange({ days: 0 }));
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const maxDays = expectDateRange(testApi.resolveDateRange({ days: Number.MAX_SAFE_INTEGER }));
    expect(maxDays.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(maxDays.startMs).toBe(Date.UTC(2026, 1, 5) - (36600 - 1) * dayMs);

    const def = expectDateRange(testApi.resolveDateRange({}));
    expect(def.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(def.startMs).toBe(Date.UTC(2026, 1, 5) - 29 * dayMs);
  });

  it("loadCostUsageSummaryCached caches within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const config = {} as OpenClawConfig;
    const a = await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    const b = await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });

    expect(a.totals.totalTokens).toBe(1);
    expect(b.totals.totalTokens).toBe(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls.at(0)?.[0]?.refreshMode).toBe(
      "background",
    );
  });

  it("keeps refreshing cost summaries fresh for the TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));
    vi.mocked(loadCostUsageSummaryFromCache).mockResolvedValueOnce({
      ...costSummary({ totalTokens: 1, totalCost: 0 }),
      cacheStatus: {
        status: "refreshing",
        cachedFiles: 1,
        pendingFiles: 1,
        staleFiles: 1,
      },
    });

    const config = {
      agents: { entries: { ops: { default: true } } },
    } as OpenClawConfig;
    await testApi.loadCostUsageSummaryCached({ startMs: 1, endMs: 2, config });

    const entry = testApi.costUsageCache.get("agent:ops:1-2:gateway");
    expect(entry?.updatedAt).toBe(Date.now());
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]?.agentId).toBe("ops");

    await vi.advanceTimersByTimeAsync(29_999);
    await testApi.loadCostUsageSummaryCached({ startMs: 1, endMs: 2, config });
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await testApi.loadCostUsageSummaryCached({ startMs: 1, endMs: 2, config });
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(2);
  });

  it("keeps cost usage cache entries scoped by agentId", async () => {
    const config = {} as OpenClawConfig;

    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
      agentId: "main",
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
      agentId: "research",
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
      agentId: "research",
    });

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls.at(0)?.[0]).toMatchObject({
      agentId: "main",
    });
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls.at(1)?.[0]).toMatchObject({
      agentId: "research",
    });
  });

  it("refreshes aggregate cost usage when the configured agent set changes", async () => {
    const request = { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" };
    const respond = vi.fn();
    for (const entries of [{ main: {} }, { main: {}, research: {} }]) {
      await expectDefined(
        usageHandlers["usage.cost"],
        "cost handler",
      )({
        respond,
        params: request,
        context: { getRuntimeConfig: () => ({ agents: { entries } }) },
      } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
    }
    expect(respond.mock.calls.map((call) => call[1].totals.totalTokens)).toEqual([1, 2]);
  });

  it("keeps cost usage cache entries scoped by the complete day bucket", async () => {
    const config = {} as OpenClawConfig;

    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      config,
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: -300 },
      config,
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      dayBucket: { mode: "time-zone", timeZone: "America/New_York" },
      config,
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      config,
    });
    await testApi.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      dayBucket: { mode: "time-zone", timeZone: "America/New_York" },
      config,
    });

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(3);
  });

  it("passes usage.cost agentId through to the cost summary loader", async () => {
    const respond = vi.fn();

    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentId: "research" },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("buckets usage.cost daily rows with the requested UTC offset", async () => {
    const respond = vi.fn();

    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        mode: "specific",
        utcOffset: "UTC-5",
      },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: -300 },
      }),
    );
  });

  it("uses an IANA timezone for usage.cost range boundaries and day buckets", async () => {
    const respond = vi.fn();

    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: {
        startDate: "2026-10-25",
        endDate: "2026-10-25",
        mode: "specific",
        timeZone: "Europe/Vienna",
        utcOffset: "UTC+2",
      },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        startMs: Date.UTC(2026, 9, 24, 22),
        endMs: Date.UTC(2026, 9, 25, 23) - 1,
        dayBucket: { mode: "time-zone", timeZone: "Europe/Vienna" },
      }),
    );
  });

  it("passes usage.cost all-agent scope through to all configured agent loaders", async () => {
    const respond = vi.fn();

    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
      context: {
        getRuntimeConfig: () => ({
          agents: { list: [{ id: "main" }, { id: "research" }] },
        }),
      },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        totals: expect.objectContaining({ totalTokens: 2 }),
      }),
      undefined,
    );
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("aggregates all-agent cost over the gateway agent universe, including on-disk system agents", async () => {
    await withTestDir({ prefix: "openclaw-usage-universe-" }, async (stateDir) => {
      await fs.mkdir(`${stateDir}/agents/openclaw`, { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expectDefined(
          usageHandlers["usage.cost"],
          'usageHandlers["usage.cost"] test invariant',
        )({
          respond: vi.fn(),
          params: { startDate: "2026-02-03", endDate: "2026-02-04", agentScope: "all" },
          context: {
            getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
          },
        } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
      });

      const loadedAgentIds = vi
        .mocked(loadCostUsageSummaryFromCache)
        .mock.calls.map((call) => (call[0] as { agentId?: string }).agentId);
      expect(loadedAgentIds).toContain("main");
      // sessions.usage discovers this on-disk system agent's sessions; cost
      // totals must cover the same agent set or the two views diverge.
      expect(loadedAgentIds).toContain("openclaw");
    });
  });

  it("does not project local avatar bytes for usage-only agent enumeration", async () => {
    await withTestDir({ prefix: "openclaw-usage-avatar-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/avatar.png`, "avatar");
      const config: OpenClawConfig = {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };
      const readSync = vi.spyOn(fsSync, "readSync");
      try {
        await expectDefined(
          usageHandlers["usage.cost"],
          'usageHandlers["usage.cost"] test invariant',
        )({
          respond: vi.fn(),
          params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
          context: { getRuntimeConfig: () => config },
        } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
        await expectDefined(
          usageHandlers["sessions.usage"],
          'usageHandlers["sessions.usage"] test invariant',
        )({
          respond: vi.fn(),
          params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
          context: { getRuntimeConfig: () => config },
        } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

        expect(readSync).not.toHaveBeenCalled();
      } finally {
        readSync.mockRestore();
      }
    });
  });

  it("aggregates usage.cost only for explicit all-agent scope", async () => {
    vi.mocked(loadCostUsageSummaryFromCache).mockImplementation(async (params) =>
      params?.agentId === "opus"
        ? costSummary({ totalTokens: 20, totalCost: 2 })
        : costSummary({ totalTokens: 10, totalCost: 1 }),
    );

    const config = {
      agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
      session: {},
    } as OpenClawConfig;
    const context = { getRuntimeConfig: () => config };
    const params = { startDate: "2026-02-01", endDate: "2026-02-01", mode: "utc" };

    const defaultRespond = vi.fn();
    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond: defaultRespond,
      params,
      context,
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(defaultRespond.mock.calls[0]?.[1]).toMatchObject({
      totals: { totalTokens: 10, totalCost: 1 },
    });

    const aggregateRespond = vi.fn();
    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond: aggregateRespond,
      params: { ...params, agentScope: "all" },
      context,
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(loadCostUsageSummaryFromCache)
        .mock.calls.slice(1)
        .map((call) => call[0]?.agentId),
    ).toEqual(["main", "opus"]);
    expect(aggregateRespond.mock.calls[0]?.[0]).toBe(true);
    expect(aggregateRespond.mock.calls[0]?.[1]).toMatchObject({
      totals: { totalTokens: 30, totalCost: 3 },
      daily: [{ date: "2026-02-01", totalTokens: 30, totalCost: 3 }],
    });

    const mainRespond = vi.fn();
    await expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond: mainRespond,
      params: { ...params, agentId: "main" },
      context,
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(3);
    expect(mainRespond.mock.calls[0]?.[1]).toMatchObject({
      totals: { totalTokens: 10, totalCost: 1 },
    });
  });

  it("bounds usage.cost all-agent cache loads", async () => {
    const agentCount = 13;
    const concurrencyLimit = 12;
    let releaseLoads!: () => void;
    const loadsReleased = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    let resolveFirstBatchStarted!: () => void;
    const firstBatchStarted = new Promise<void>((resolve) => {
      resolveFirstBatchStarted = resolve;
    });
    let started = 0;
    let inFlight = 0;
    let peakInFlight = 0;

    vi.mocked(loadCostUsageSummaryFromCache).mockImplementation(async () => {
      started += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (started === concurrencyLimit) {
        resolveFirstBatchStarted();
      }
      await loadsReleased;
      inFlight -= 1;
      return costSummary({ totalTokens: 1, totalCost: 0 });
    });

    const respond = vi.fn();
    const request = expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
      context: {
        getRuntimeConfig: () => ({
          agents: {
            list: Array.from({ length: agentCount }, (_, i) => ({ id: `agent-${i}` })),
          },
        }),
      },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    await firstBatchStarted;
    const startedBeforeRelease = started;
    const peakBeforeRelease = peakInFlight;
    releaseLoads();
    await request;

    expect(startedBeforeRelease).toBe(concurrencyLimit);
    expect(peakBeforeRelease).toBe(concurrencyLimit);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        totals: expect.objectContaining({ totalTokens: agentCount }),
      }),
      undefined,
    );
  });

  it("rejects an all-agent usage load when one agent task fails", async () => {
    const failure = new Error("agent usage load failed");
    vi.mocked(loadCostUsageSummaryFromCache)
      .mockResolvedValueOnce(costSummary({ totalTokens: 1, totalCost: 0 }))
      .mockRejectedValueOnce(failure);

    const respond = vi.fn();
    const request = expectDefined(
      usageHandlers["usage.cost"],
      'usageHandlers["usage.cost"] test invariant',
    )({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
      context: {
        getRuntimeConfig: () => ({
          agents: { list: [{ id: "main" }, { id: "broken" }] },
        }),
      },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    await expect(request).rejects.toBe(failure);
    expect(respond).not.toHaveBeenCalled();
  });

  it("bounds sessions.usage all-agent session discovery", async () => {
    const agentCount = 13;
    const concurrencyLimit = 12;
    let releaseLoads!: () => void;
    const loadsReleased = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    let resolveFirstBatchStarted!: () => void;
    const firstBatchStarted = new Promise<void>((resolve) => {
      resolveFirstBatchStarted = resolve;
    });
    let started = 0;
    let inFlight = 0;
    let peakInFlight = 0;

    vi.mocked(discoverAllSessions).mockImplementation(async () => {
      started += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (started === concurrencyLimit) {
        resolveFirstBatchStarted();
      }
      await loadsReleased;
      inFlight -= 1;
      return [];
    });

    const respond = vi.fn();
    const request = expectDefined(
      usageHandlers["sessions.usage"],
      'usageHandlers["sessions.usage"] test invariant',
    )({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentScope: "all" },
      context: {
        getRuntimeConfig: () => ({
          agents: {
            list: Array.from({ length: agentCount }, (_, i) => ({ id: `agent-${i}` })),
          },
        }),
      },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);

    await firstBatchStarted;
    const startedBeforeRelease = started;
    const peakBeforeRelease = peakInFlight;
    releaseLoads();
    await request;

    expect(startedBeforeRelease).toBe(concurrencyLimit);
    expect(peakBeforeRelease).toBe(concurrencyLimit);
    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(agentCount);
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
  });
});
