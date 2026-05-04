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
      totals: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
    })),
  };
});

import { loadCostUsageSummaryFromCache } from "../../infra/session-cost-usage.js";
import { __test } from "./usage.js";

describe("gateway usage helpers", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    __test.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parseDateToMs accepts YYYY-MM-DD and rejects invalid input", () => {
    expect(__test.parseDateToMs("2026-02-05")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs(" 2026-02-05 ")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs("2026-2-5")).toBeUndefined();
    expect(__test.parseDateToMs("nope")).toBeUndefined();
    expect(__test.parseDateToMs(undefined)).toBeUndefined();
  });

  it("parseUtcOffsetToMinutes supports whole-hour and half-hour offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC-4")).toBe(-240);
    expect(__test.parseUtcOffsetToMinutes("UTC+5:30")).toBe(330);
    expect(__test.parseUtcOffsetToMinutes(" UTC+14 ")).toBe(14 * 60);
  });

  it("parseUtcOffsetToMinutes rejects invalid offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC+14:30")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+5:99")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+25")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("GMT+5")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes(undefined)).toBeUndefined();
  });

  it("parseDays coerces strings/numbers to integers", () => {
    expect(__test.parseDays(7.9)).toBe(7);
    expect(__test.parseDays("30")).toBe(30);
    expect(__test.parseDays("")).toBeUndefined();
    expect(__test.parseDays("nope")).toBeUndefined();
  });

  it("parseDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const range = __test.parseDateRange({ startDate: "2026-02-01", endDate: "2026-02-02" });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses explicit UTC mode", () => {
    const range = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "utc",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific UTC offset for explicit dates", () => {
    const range = __test.parseDateRange({
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
    const missingOffset = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
    });
    const invalidOffset = __test.parseDateRange({
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
    const range = __test.parseDateRange({
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
    const range = __test.parseDateRange({ days: 1, mode: "gateway" });
    const expectedStart = new Date(2026, 1, 5).getTime();
    expect(range.startMs).toBe(expectedStart);
    expect(range.endMs).toBe(expectedStart + dayMs - 1);
  });

  it("parseDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = __test.parseDateRange({ days: 0 });
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const def = __test.parseDateRange({});
    expect(def.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(def.startMs).toBe(Date.UTC(2026, 1, 5) - 29 * dayMs);
  });

  it("loadCostUsageSummaryCached caches within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const config = {} as OpenClawConfig;
    const a = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    const b = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });

    expect(a.totals.totalTokens).toBe(1);
    expect(b.totals.totalTokens).toBe(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]).toMatchObject({
      refreshMode: "sync-when-empty",
    });
  });
});
