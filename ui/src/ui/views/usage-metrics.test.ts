import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildPeakErrorHours,
  buildUsageMosaicStats,
  getHourAndWeekdayForUtcQuarterBucket,
  sessionTouchesSelectedHours,
} from "./usage-metrics.ts";
import type { UsageSessionEntry } from "./usageTypes.ts";

/**
 * Helper: build a minimal UsageSessionEntry with utcQuarterHourMessageCounts
 * using the new UTC quarter-hour bucket format.
 */
function makeSessionWithQuarterHourly(
  buckets: Array<{
    date: string;
    quarterIndex: number;
    total: number;
    errors: number;
  }>,
): UsageSessionEntry {
  return {
    key: "test-session",
    usage: {
      totalTokens: 100,
      totalCost: 0.01,
      input: 50,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
      firstActivity: Date.now() - 3600_000,
      lastActivity: Date.now(),
      messageCounts: {
        total: buckets.reduce((sum, b) => sum + b.total, 0),
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: buckets.reduce((sum, b) => sum + b.errors, 0),
      },
      utcQuarterHourMessageCounts: buckets.map((b) => ({
        date: b.date,
        quarterIndex: b.quarterIndex,
        total: b.total,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: b.errors,
      })),
    },
  } as unknown as UsageSessionEntry;
}

describe("buildPeakErrorHours", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps UTC quarter-hour buckets to correct hours in UTC mode", () => {
    // quarterIndex 0  → 00:00-00:14 UTC → hour 0
    // quarterIndex 4  → 01:00-01:14 UTC → hour 1
    // quarterIndex 36 → 09:00-09:14 UTC → hour 9
    // quarterIndex 95 → 23:45-23:59 UTC → hour 23
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 5 },
      { date: "2026-03-15", quarterIndex: 4, total: 20, errors: 2 },
      { date: "2026-03-15", quarterIndex: 36, total: 15, errors: 3 },
      { date: "2026-03-15", quarterIndex: 95, total: 8, errors: 4 },
    ]);

    const result = buildPeakErrorHours([session], "utc");

    // All hours with errors should appear, sorted by error rate desc
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(5);

    // The hours present should correspond to UTC hours 0, 1, 9, 23.
    // formatHourLabel uses Date.setHours so labels depend on locale,
    // but we can verify error rates and sub info.
    const highestRate = result[0];
    expect(highestRate).toBeDefined();
    // hour 0: 5/10 = 50%, hour 23: 4/8 = 50%, hour 9: 3/15 = 20%, hour 1: 2/20 = 10%
    expect(highestRate.value).toMatch(/50\.00%/);
  });

  it("aggregates multiple quarter-hour buckets into the same hour in UTC mode", () => {
    // quarterIndex 0 (00:00) and quarterIndex 3 (00:45) both map to hour 0
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 2 },
      { date: "2026-03-15", quarterIndex: 3, total: 5, errors: 3 },
    ]);

    const result = buildPeakErrorHours([session], "utc");
    expect(result.length).toBe(1);
    // Aggregated: 5 errors / 15 total = 33.33%
    expect(result[0].value).toBe("33.33%");
    expect(result[0].sub).toContain("5 errors");
    expect(result[0].sub).toContain("15 msgs");
  });

  it("shifts UTC quarter-hour buckets to local timezone in local mode", () => {
    // Simulate UTC+5: UTC hour 0 → local hour 5, UTC hour 10 → local hour 15
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 5) % 24;
    });

    // quarterIndex 0 → UTC 00:00 → local 05:00
    // quarterIndex 40 → UTC 10:00 → local 15:00
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 3 },
      { date: "2026-03-15", quarterIndex: 40, total: 20, errors: 4 },
    ]);

    const result = buildPeakErrorHours([session], "local");
    expect(result.length).toBe(2);

    // Verify the sub info matches aggregated values
    const subs = result.map((r) => r.sub);
    expect(subs).toContain("3 errors · 10 msgs"); // local hour 5
    expect(subs).toContain("4 errors · 20 msgs"); // local hour 15
  });

  it("wraps correctly for negative local timezone (UTC-8)", () => {
    // Simulate UTC-8: UTC hour 0 → local hour 16 (previous day)
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() - 8 + 24) % 24;
    });

    // quarterIndex 0 → UTC 00:00 → local 16:00
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 0, total: 10, errors: 5 },
    ]);

    const result = buildPeakErrorHours([session], "local");
    expect(result.length).toBe(1);
    expect(result[0].value).toBe("50.00%");
    expect(result[0].sub).toContain("5 errors");
    expect(result[0].sub).toContain("10 msgs");
  });

  it("wraps correctly for positive local timezone near midnight (UTC+8, late quarter)", () => {
    // Simulate UTC+8: UTC hour 17 → local hour 1 (next day)
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 8) % 24;
    });

    // quarterIndex 68 → UTC 17:00 → local 01:00 (next day)
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 68, total: 12, errors: 6 },
    ]);

    const result = buildPeakErrorHours([session], "local");
    expect(result.length).toBe(1);
    expect(result[0].value).toBe("50.00%");
    expect(result[0].sub).toContain("6 errors");
    expect(result[0].sub).toContain("12 msgs");
  });

  it("returns empty array when no sessions have errors", () => {
    const session = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 10, total: 50, errors: 0 },
    ]);

    const result = buildPeakErrorHours([session], "utc");
    expect(result).toEqual([]);
  });

  it("returns empty array when sessions have no message counts", () => {
    const session: UsageSessionEntry = {
      key: "empty",
      usage: {
        totalTokens: 0,
        totalCost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        messageCounts: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      },
    } as unknown as UsageSessionEntry;

    const result = buildPeakErrorHours([session], "utc");
    expect(result).toEqual([]);
  });

  it("limits results to at most 5 entries sorted by error rate", () => {
    // Create 8 different hours with errors
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      date: "2026-03-15",
      quarterIndex: i * 8, // hours 0,2,4,6,8,10,12,14
      total: 100,
      errors: (i + 1) * 2, // increasing error counts
    }));
    const session = makeSessionWithQuarterHourly(buckets);

    const result = buildPeakErrorHours([session], "utc");
    expect(result.length).toBe(5);

    // Should be sorted by rate descending — highest rate first
    const rates = result.map((r) => Number.parseFloat(r.value));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i - 1]).toBeGreaterThanOrEqual(rates[i]);
    }
  });

  it("aggregates across multiple sessions", () => {
    const session1 = makeSessionWithQuarterHourly([
      { date: "2026-03-15", quarterIndex: 20, total: 10, errors: 3 },
    ]);
    const session2 = makeSessionWithQuarterHourly([
      { date: "2026-03-16", quarterIndex: 20, total: 20, errors: 7 },
    ]);

    const result = buildPeakErrorHours([session1, session2], "utc");
    expect(result.length).toBe(1);
    // quarterIndex 20 → hour 5: aggregated 10 errors / 30 msgs = 33.33%
    expect(result[0].value).toBe("33.33%");
    expect(result[0].sub).toContain("10 errors");
    expect(result[0].sub).toContain("30 msgs");
  });

  it("falls back to proportional allocation when utcQuarterHourMessageCounts is absent", () => {
    // Session without utcQuarterHourMessageCounts should use forEachSessionHourSlice
    const now = Date.now();
    const session: UsageSessionEntry = {
      key: "fallback-session",
      updatedAt: now,
      usage: {
        totalTokens: 100,
        totalCost: 0.01,
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: now - 3600_000,
        lastActivity: now,
        messageCounts: {
          total: 10,
          user: 5,
          assistant: 5,
          toolCalls: 0,
          toolResults: 0,
          errors: 3,
        },
        // No utcQuarterHourMessageCounts -> fallback path
      },
    } as unknown as UsageSessionEntry;

    const result = buildPeakErrorHours([session], "utc");
    // Should still produce results via the proportional allocation fallback
    expect(result.length).toBeGreaterThan(0);
    // All errors (3) should be distributed proportionally
    const totalErrors = result.reduce((sum, r) => {
      const match = r.sub.match(/(\d+) errors/);
      return sum + (match ? Number.parseInt(match[1], 10) : 0);
    }, 0);
    expect(totalErrors).toBe(3);
  });
});

describe("usage mosaic token buckets", () => {
  const makeSessionWithTokenBuckets = (
    buckets: Array<{
      date: string;
      quarterIndex: number;
      totalTokens: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }>,
  ): UsageSessionEntry =>
    ({
      key: "token-bucket-session",
      usage: {
        totalTokens: buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
        totalCost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T10:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T12:00:00.000Z"),
        utcQuarterHourTokenUsage: buckets.map((bucket) => ({
          date: bucket.date,
          quarterIndex: bucket.quarterIndex,
          input: bucket.input ?? 0,
          output: bucket.output ?? bucket.totalTokens,
          cacheRead: bucket.cacheRead ?? 0,
          cacheWrite: bucket.cacheWrite ?? 0,
          totalTokens: bucket.totalTokens,
          totalCost: 0,
        })),
      },
    }) as unknown as UsageSessionEntry;

  it("maps UTC quarter-hour buckets and rejects invalid bucket coordinates", () => {
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 40, "utc")).toEqual({
      hour: 10,
      weekday: 0,
    });
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", -1, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 96, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("2026-13-01", 40, "utc")).toBeNull();
    expect(getHourAndWeekdayForUtcQuarterBucket("not-a-date", 40, "utc")).toBeNull();
  });

  it("uses local timezone mapping for UTC quarter-hour buckets", () => {
    vi.spyOn(Date.prototype, "getHours").mockImplementation(function (this: Date) {
      return (this.getUTCHours() + 8) % 24;
    });
    vi.spyOn(Date.prototype, "getDay").mockReturnValue(1);

    expect(getHourAndWeekdayForUtcQuarterBucket("2026-02-01", 68, "local")).toEqual({
      hour: 1,
      weekday: 1,
    });
  });

  it("uses precise token buckets instead of spreading session totals across the session span", () => {
    const session = makeSessionWithTokenBuckets([
      { date: "2026-02-01", quarterIndex: 40, totalTokens: 10_000 },
    ]);

    const stats = buildUsageMosaicStats([session], "utc");

    expect(stats.totalTokens).toBe(10_000);
    expect(stats.hourTotals[10]).toBe(10_000);
    expect(stats.hourTotals[11]).toBe(0);
  });

  it("filters selected hours by precise token buckets before falling back to session span", () => {
    const session = makeSessionWithTokenBuckets([
      { date: "2026-02-01", quarterIndex: 40, totalTokens: 10_000 },
    ]);

    expect(sessionTouchesSelectedHours(session, [10], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(false);
  });

  it("preserves legacy session-span hour filtering when token buckets are absent", () => {
    const session = {
      key: "legacy-span-session",
      usage: {
        totalTokens: 100,
        totalCost: 0,
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T10:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T11:00:00.000Z"),
      },
    } as unknown as UsageSessionEntry;

    expect(sessionTouchesSelectedHours(session, [10], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(true);
    expect(sessionTouchesSelectedHours(session, [12], "utc")).toBe(false);
  });

  it("falls back to session span when token buckets contain no valid positive tokens", () => {
    const session = {
      key: "empty-token-bucket-session",
      usage: {
        totalTokens: 100,
        totalCost: 0,
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
        firstActivity: Date.parse("2026-02-01T11:00:00.000Z"),
        lastActivity: Date.parse("2026-02-01T11:00:00.000Z"),
        utcQuarterHourTokenUsage: [
          {
            date: "2026-02-01",
            quarterIndex: 40,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0,
          },
        ],
      },
    } as unknown as UsageSessionEntry;

    expect(sessionTouchesSelectedHours(session, [11], "utc")).toBe(true);
  });
});
