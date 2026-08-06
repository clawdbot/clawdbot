/**
 * Tests for usage-report gateway methods and aggregation responses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

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
  };
});

import { loadCostUsageSummaryFromCache } from "../../infra/session-cost-usage.js";
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
    range: ReturnType<typeof testApi.parseDateRange>,
    startDate: string,
    endDate: string,
  ) {
    expect(range.startMs).toBe(testApi.parseDateToMs(startDate));
    expect(range.endMs).toBe(testApi.parseDateToMs(endDate)! + dayMs - 1);
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

  it("findInvalidExplicitDate flags provided-but-unparseable dates and ignores absent/valid ones", () => {
    // Explicitly provided invalid dates (bad format or impossible calendar date) are reported.
    expect(testApi.findInvalidExplicitDate({ startDate: "2026-02-30" })).toBe("startDate");
    expect(testApi.findInvalidExplicitDate({ endDate: "2026-2-5" })).toBe("endDate");
    expect(testApi.findInvalidExplicitDate({ startDate: 0 })).toBe("startDate");
    expect(testApi.findInvalidExplicitDate({ endDate: [] })).toBe("endDate");
    expect(
      testApi.findInvalidExplicitDate({ startDate: "2026-02-01", endDate: "2026-13-01" }),
    ).toBe("endDate");
    // Absent or valid dates are not flagged, so they still fall through to the default range.
    expect(testApi.findInvalidExplicitDate({})).toBeUndefined();
    expect(testApi.findInvalidExplicitDate({ startDate: "", endDate: null })).toBeUndefined();
    expect(
      testApi.findInvalidExplicitDate({ startDate: "2026-02-01", endDate: "2026-02-02" }),
    ).toBeUndefined();
  });

  it("usage.cost rejects an explicitly provided invalid date with INVALID_REQUEST", async () => {
    const respond = vi.fn();
    await usageHandlers["usage.cost"]({
      respond,
      params: { startDate: 0 },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(JSON.stringify(error)).toContain("startDate");
    // A rejected request must not query the cost loader for an unrelated range.
    expect(vi.mocked(loadCostUsageSummaryFromCache)).not.toHaveBeenCalled();
  });

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

  it("parseDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const range = testApi.parseDateRange({ startDate: "2026-02-01", endDate: "2026-02-02" });
    expectUtcDateRange(range, "2026-02-01", "2026-02-02");
  });

  it("parseDateRange uses explicit UTC mode", () => {
    const range = testApi.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "utc",
    });
    expectUtcDateRange(range, "2026-02-01", "2026-02-02");
  });

  it("parseDateRange uses specific UTC offset for explicit dates", () => {
    const range = testApi.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "UTC+5:30",
    });
    const start = Date.UTC(2026, 1, 1) - 5.5 * 60 * 60 * 1000;
    const endStart = Date.UTC(2026, 1, 2) - 5.5 * 60 * 60 * 1000;
    expect(range.startMs).toBe(start);
    expect(range.endMs).toBe(endStart + dayMs - 1);
  });

  it("parseDateRange falls back to UTC when specific mode offset is missing or invalid", () => {
    const missingOffset = testApi.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
    });
    const invalidOffset = testApi.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "bad-value",
    });
    expect(missingOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(missingOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
    expect(invalidOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(invalidOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific offset for today/day math after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
    const range = testApi.parseDateRange({
      days: 1,
      mode: "specific",
      utcOffset: "UTC-5",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 16, 5, 0, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 17, 4, 59, 59, 999));
  });

  it("parseDateRange uses gateway local day boundaries in gateway mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const range = testApi.parseDateRange({ days: 1, mode: "gateway" });
    const expectedStart = new Date(2026, 1, 5).getTime();
    expect(range.startMs).toBe(expectedStart);
    expect(range.endMs).toBe(expectedStart + dayMs - 1);
  });

  it("parseDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = testApi.parseDateRange({ days: 0 });
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const def = testApi.parseDateRange({});
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

  it("passes usage.cost agentId through to the cost summary loader", async () => {
    const respond = vi.fn();

    await usageHandlers["usage.cost"]({
      respond,
      params: { startDate: "2026-02-01", endDate: "2026-02-02", agentId: "research" },
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("passes usage.cost all-agent scope through to all configured agent loaders", async () => {
    const respond = vi.fn();

    await usageHandlers["usage.cost"]({
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
    await usageHandlers["usage.cost"]({
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
    await usageHandlers["usage.cost"]({
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
    await usageHandlers["usage.cost"]({
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
});
