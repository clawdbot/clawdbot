/**
 * Tests for usage-report gateway methods and aggregation responses.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";

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
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
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
    expect(range.startMs).toBe(testApi.parseDateToMs(startDate));
    expect(range.endMs).toBe(testApi.parseDateToMs(endDate)! + dayMs - 1);
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parseDateToMs accepts YYYY-MM-DD and rejects invalid input", () => {
    expect(testApi.parseDateToMs("2026-02-05")).toBe(Date.UTC(2026, 1, 5));
    expect(testApi.parseDateToMs(" 2026-02-05 ")).toBe(Date.UTC(2026, 1, 5));
    expect(testApi.parseDateToMs("2026-2-5")).toBeUndefined();
    expect(testApi.parseDateToMs("nope")).toBeUndefined();
    expect(testApi.parseDateToMs(undefined)).toBeUndefined();
  });

  it("parseDateToMs rejects out-of-range calendar dates instead of rolling them over", () => {
    // Impossible dates that still match the YYYY-MM-DD shape must not silently shift to a real day.
    expect(testApi.parseDateToMs("2026-02-30")).toBeUndefined(); // would roll to Mar 2
    expect(testApi.parseDateToMs("2026-04-31")).toBeUndefined(); // would roll to May 1
    expect(testApi.parseDateToMs("2025-02-29")).toBeUndefined(); // non-leap Feb 29
    expect(testApi.parseDateToMs("2026-13-01")).toBeUndefined(); // month too large
    expect(testApi.parseDateToMs("2026-00-10")).toBeUndefined(); // month zero
    expect(testApi.parseDateToMs("2026-01-00")).toBeUndefined(); // day zero
    // Real leap day must stay valid (guard against over-rejection).
    expect(testApi.parseDateToMs("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  });

  it.each([
    [{ startDate: "2026-02-30" }, "invalid startDate"],
    [{ endDate: "2026-2-5" }, "invalid endDate"],
    [{ startDate: 0 }, "invalid startDate"],
    [{ endDate: [] }, "invalid endDate"],
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

  it("parseUtcOffsetToMinutes supports whole-hour and half-hour offsets", () => {
    expect(testApi.parseUtcOffsetToMinutes("UTC-4")).toBe(-240);
    expect(testApi.parseUtcOffsetToMinutes("UTC+5:30")).toBe(330);
    expect(testApi.parseUtcOffsetToMinutes(" UTC+14 ")).toBe(14 * 60);
  });

  it("parseUtcOffsetToMinutes rejects invalid offsets", () => {
    expect(testApi.parseUtcOffsetToMinutes("UTC+14:30")).toBeUndefined();
    expect(testApi.parseUtcOffsetToMinutes("UTC+5:99")).toBeUndefined();
    expect(testApi.parseUtcOffsetToMinutes("UTC+25")).toBeUndefined();
    expect(testApi.parseUtcOffsetToMinutes("GMT+5")).toBeUndefined();
    expect(testApi.parseUtcOffsetToMinutes(undefined)).toBeUndefined();
  });

  it("parseDays coerces strings/numbers to integers", () => {
    expect(testApi.parseDays(7.9)).toBe(7);
    expect(testApi.parseDays("30")).toBe(30);
    expect(testApi.parseDays("")).toBeUndefined();
    expect(testApi.parseDays("nope")).toBeUndefined();
  });

  it("resolveDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const result = testApi.resolveDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
    });
    expectUtcDateRange(result, "2026-02-01", "2026-02-02");
  });

  it("resolveDateRange uses explicit UTC mode", () => {
    const result = testApi.resolveDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "utc",
    });
    expectUtcDateRange(result, "2026-02-01", "2026-02-02");
  });

  it("resolveDateRange uses specific UTC offset for explicit dates", () => {
    const range = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        mode: "specific",
        utcOffset: "UTC+5:30",
      }),
    );
    const start = Date.UTC(2026, 1, 1) - 5.5 * 60 * 60 * 1000;
    const endStart = Date.UTC(2026, 1, 2) - 5.5 * 60 * 60 * 1000;
    expect(range.startMs).toBe(start);
    expect(range.endMs).toBe(endStart + dayMs - 1);
  });

  it("resolveDateRange uses IANA timezone boundaries across a DST transition", () => {
    const range = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2026-10-25",
        endDate: "2026-10-25",
        mode: "specific",
        timeZone: "Europe/Vienna",
        // The IANA zone must take precedence over this pre-transition fixed offset.
        utcOffset: "UTC+2",
      }),
    );

    expect(range.startMs).toBe(Date.UTC(2026, 9, 24, 22));
    expect(range.endMs).toBe(Date.UTC(2026, 9, 25, 23) - 1);
  });

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

  it("resolveDateRange falls back to UTC when specific mode offset is missing or invalid", () => {
    const missingOffset = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        mode: "specific",
      }),
    );
    const invalidOffset = expectDateRange(
      testApi.resolveDateRange({
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        mode: "specific",
        utcOffset: "bad-value",
      }),
    );
    expect(missingOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(missingOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
    expect(invalidOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(invalidOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

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

  it("resolveDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = expectDateRange(testApi.resolveDateRange({ days: 0 }));
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

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

  it("does not project local avatar bytes for usage-only agent enumeration", async () => {
    await withTempDir({ prefix: "openclaw-usage-avatar-" }, async (workspace) => {
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
      agents: { list: [{ id: "main" }, { id: "opus" }] },
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
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]?.agentId).toBeUndefined();
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

    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[3]?.[0]?.agentId).toBe("main");
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
