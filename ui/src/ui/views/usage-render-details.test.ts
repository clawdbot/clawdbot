import { describe, it, expect } from "vitest";
import {
  computeFilteredUsage,
  CHART_BAR_WIDTH_RATIO,
  CHART_MAX_BAR_WIDTH,
} from "./usage-render-details.ts";
import type { TimeSeriesPoint, UsageSessionEntry } from "./usageTypes.ts";

function makePoint(overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    timestamp: 1000,
    totalTokens: 100,
    cost: 0.01,
    input: 30,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cumulativeTokens: 0,
    cumulativeCost: 0,
    ...overrides,
  };
}

const baseUsage = {
  totalTokens: 1000,
  totalCost: 1.0,
  input: 300,
  output: 400,
  cacheRead: 200,
  cacheWrite: 100,
  inputCost: 0.3,
  outputCost: 0.4,
  cacheReadCost: 0.2,
  cacheWriteCost: 0.1,
  durationMs: 60000,
  firstActivity: 0,
  lastActivity: 60000,
  missingCostEntries: 0,
  messageCounts: {
    total: 10,
    user: 5,
    assistant: 5,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
} satisfies NonNullable<UsageSessionEntry["usage"]>;

function expectFilteredUsage(
  result: ReturnType<typeof computeFilteredUsage>,
): NonNullable<ReturnType<typeof computeFilteredUsage>> {
  if (!result) {
    throw new Error("Expected filtered usage result");
  }
  return result;
}

describe("computeFilteredUsage", () => {
  it("returns undefined when no points match the range", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 2000 })];
    const result = computeFilteredUsage(baseUsage, points, 3000, 4000);
    expect(result).toBeUndefined();
  });

  it("aggregates tokens and cost for points within range", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 100, cost: 0.1 }),
      makePoint({ timestamp: 2000, totalTokens: 200, cost: 0.2 }),
      makePoint({ timestamp: 3000, totalTokens: 300, cost: 0.3 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    const filtered = expectFilteredUsage(result);
    expect(filtered.totalTokens).toBe(300); // 100 + 200
    expect(filtered.totalCost).toBeCloseTo(0.3); // 0.1 + 0.2
  });

  it("handles reversed range (end < start)", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 50 }),
      makePoint({ timestamp: 2000, totalTokens: 75 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 2000, 1000);
    expect(expectFilteredUsage(result).totalTokens).toBe(125);
  });

  it("counts message types based on input/output presence", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 0 }),
      makePoint({ timestamp: 2000, input: 0, output: 20 }),
      makePoint({ timestamp: 3000, input: 5, output: 15 }),
    ];
    const result = expectFilteredUsage(computeFilteredUsage(baseUsage, points, 1000, 3000));
    const counts = result.messageCounts;
    if (!counts) {
      throw new Error("expected filtered usage to include message counts");
    }
    expect(counts.user).toBe(2); // points with input > 0
    expect(counts.assistant).toBe(2); // points with output > 0
    expect(counts.total).toBe(3);
  });

  it("computes duration from first to last filtered point", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 5000 })];
    const result = expectFilteredUsage(computeFilteredUsage(baseUsage, points, 1000, 5000));
    expect(result.durationMs).toBe(4000);
    expect(result.firstActivity).toBe(1000);
    expect(result.lastActivity).toBe(5000);
  });

  it("aggregates token types (input, output, cacheRead, cacheWrite)", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
      makePoint({ timestamp: 2000, input: 5, output: 15, cacheRead: 25, cacheWrite: 35 }),
    ];
    const result = expectFilteredUsage(computeFilteredUsage(baseUsage, points, 1000, 2000));
    expect(result.input).toBe(15);
    expect(result.output).toBe(35);
    expect(result.cacheRead).toBe(55);
    expect(result.cacheWrite).toBe(75);
  });
});

describe("chart bar sizing", () => {
  it("keeps the chart bar sizing constants stable", () => {
    expect(CHART_BAR_WIDTH_RATIO).toBe(0.75);
    expect(CHART_MAX_BAR_WIDTH).toBe(8);
  });

  it("bars fit within chart width for typical point counts", () => {
    const chartWidth = 366; // typical: 400 - padding.left(30) - padding.right(4)
    // For reasonable point counts (up to ~300), bars should fit
    for (const n of [1, 2, 10, 50, 100, 200]) {
      const slotWidth = chartWidth / n;
      const barWidth = Math.min(
        CHART_MAX_BAR_WIDTH,
        Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO),
      );
      const barGap = slotWidth - barWidth;
      // Slot-based sizing guarantees total = n * slotWidth = chartWidth
      expect(n * slotWidth).toBeCloseTo(chartWidth);
      // Bar gap is non-negative when slotWidth >= 1 / CHART_BAR_WIDTH_RATIO
      if (slotWidth >= 1 / CHART_BAR_WIDTH_RATIO) {
        expect(barGap).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
