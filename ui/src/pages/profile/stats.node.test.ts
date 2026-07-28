// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import {
  buildHeatmap,
  buildInsights,
  computeStreaks,
  firstActiveDate,
  formatLongDuration,
  formatTokenScale,
  peakDay,
} from "./stats.ts";

const day = (date: string, totalTokens: number) => ({ date, totalTokens });

function usageTotals(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

describe("formatTokenScale", () => {
  it("covers unit tiers with one decimal below 100", () => {
    expect(formatTokenScale(0)).toBe("0");
    expect(formatTokenScale(412)).toBe("412");
    expect(formatTokenScale(1400)).toBe("1.4k");
    expect(formatTokenScale(2_000_000)).toBe("2M");
    expect(formatTokenScale(82_100_000_000)).toBe("82.1B");
    expect(formatTokenScale(250_000_000_000)).toBe("250B");
    expect(formatTokenScale(2_800_000_000_000)).toBe("2.8T");
  });

  it("treats missing values as zero", () => {
    expect(formatTokenScale(null)).toBe("0");
    expect(formatTokenScale(Number.NaN)).toBe("0");
  });
});

describe("formatLongDuration", () => {
  it("scales from seconds to hours", () => {
    expect(formatLongDuration(500)).toBe("500ms");
    expect(formatLongDuration(45_000)).toBe("45s");
    expect(formatLongDuration(12 * 60 * 1000)).toBe("12m");
    expect(formatLongDuration(3 * 60 * 60 * 1000)).toBe("3h");
    expect(formatLongDuration(59 * 60 * 60 * 1000 + 4 * 60 * 1000)).toBe("2d 11h");
  });
});

describe("computeStreaks", () => {
  it("returns zeros without activity", () => {
    expect(computeStreaks([], "2026-07-09")).toEqual({ current: 0, longest: 0 });
    expect(computeStreaks([day("2026-07-09", 0)], "2026-07-09")).toEqual({
      current: 0,
      longest: 0,
    });
  });

  it("keeps the current streak alive when today has no activity yet", () => {
    const daily = [day("2026-07-06", 5), day("2026-07-07", 5), day("2026-07-08", 5)];
    expect(computeStreaks(daily, "2026-07-09")).toEqual({ current: 3, longest: 3 });
  });

  it("resets the current streak after a full missed day", () => {
    const daily = [day("2026-07-05", 5), day("2026-07-06", 5)];
    expect(computeStreaks(daily, "2026-07-09")).toEqual({ current: 0, longest: 2 });
  });

  it("tracks the longest run across gaps and ignores unsorted input", () => {
    const daily = [
      day("2026-07-09", 1),
      day("2026-06-01", 1),
      day("2026-06-02", 1),
      day("2026-06-03", 1),
      day("2026-07-08", 1),
    ];
    expect(computeStreaks(daily, "2026-07-09")).toEqual({ current: 2, longest: 3 });
  });
});

describe("buildHeatmap", () => {
  it("covers 52 trailing weeks aligned to Sunday columns", () => {
    const heatmap = buildHeatmap([day("2026-07-09", 10)], "2026-07-09", "en-US");
    expect(heatmap.weeks.length).toBeGreaterThanOrEqual(52);
    expect(heatmap.weeks.length).toBeLessThanOrEqual(53);
    expect(heatmap.monthLabels.length).toBe(heatmap.weeks.length);

    const lastWeek = heatmap.weeks.at(-1);
    // 2026-07-09 is a Thursday: index 4 in a Sunday-first week; later slots pad null.
    expect(lastWeek?.days[4]?.date).toBe("2026-07-09");
    expect(lastWeek?.days[5]).toBeNull();
    expect(lastWeek?.days[6]).toBeNull();

    const allDays = heatmap.weeks.flatMap((week) => week.days).filter(Boolean);
    expect(allDays.length).toBe(52 * 7);
    expect(allDays[0]?.date).toBe("2025-07-11");
  });

  it("buckets nonzero days into quartile levels and zero days to level 0", () => {
    const daily = [
      day("2026-07-05", 0),
      day("2026-07-06", 10),
      day("2026-07-07", 20),
      day("2026-07-08", 30),
      day("2026-07-09", 40),
    ];
    const heatmap = buildHeatmap(daily, "2026-07-09", "en-US");
    const byDate = new Map(
      heatmap.weeks
        .flatMap((week) => week.days)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map((entry) => [entry.date, entry]),
    );
    expect(byDate.get("2026-07-05")?.level).toBe(0);
    expect(byDate.get("2026-07-06")?.level).toBe(1);
    expect(byDate.get("2026-07-07")?.level).toBe(2);
    expect(byDate.get("2026-07-08")?.level).toBe(3);
    expect(byDate.get("2026-07-09")?.level).toBe(4);
    expect(byDate.get("2026-01-01")?.level).toBe(0);
  });

  it("labels a column when a new month starts", () => {
    const heatmap = buildHeatmap([], "2026-07-09", "en-US");
    const labels = heatmap.monthLabels.filter(Boolean);
    expect(labels.length).toBeGreaterThanOrEqual(12);
    expect(heatmap.monthLabels[0]).not.toBe("");
  });
});

describe("peak and first activity", () => {
  it("finds the busiest and earliest active day", () => {
    const daily = [day("2026-01-02", 5), day("2026-01-01", 0), day("2026-03-01", 50)];
    expect(peakDay(daily)).toEqual(day("2026-03-01", 50));
    expect(firstActiveDate(daily)).toBe("2026-01-02");
    expect(peakDay([day("2026-01-01", 0)])).toBeNull();
    expect(firstActiveDate([])).toBeNull();
  });
});

describe("buildInsights", () => {
  it("prefers uncapped aggregate session stats over the row page", () => {
    const result: SessionsUsageResult = {
      updatedAt: 0,
      startDate: "2025-07-10",
      endDate: "2026-07-09",
      sessions: [{ key: "agent:main:a", usage: { ...usageTotals(10), durationMs: 5000 } }],
      totals: usageTotals(10),
      aggregates: {
        sessionCount: 4200,
        longestSessionDurationMs: 212_640_000,
        messages: { total: 1, user: 1, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
    };
    const insights = buildInsights(result);
    expect(insights.sessions).toBe(4200);
    expect(insights.sessionsCapped).toBe(false);
    expect(insights.longestSessionMs).toBe(212_640_000);
  });

  it("ranks models, tools, and channels and finds the longest session", () => {
    const result: SessionsUsageResult = {
      updatedAt: 0,
      startDate: "2025-07-10",
      endDate: "2026-07-09",
      sessions: [
        {
          key: "agent:main:a",
          usage: { ...usageTotals(10), durationMs: 5000 },
        },
        {
          key: "agent:main:b",
          usage: { ...usageTotals(10), durationMs: 90_000 },
        },
        { key: "agent:main:c", usage: null },
      ],
      totals: usageTotals(20),
      aggregates: {
        messages: { total: 12, user: 6, assistant: 6, toolCalls: 4, toolResults: 4, errors: 0 },
        tools: {
          totalCalls: 9,
          uniqueTools: 3,
          tools: [
            { name: "exec", count: 2 },
            { name: "browser", count: 6 },
            { name: "message", count: 1 },
          ],
        },
        byModel: [
          { provider: "anthropic", model: "claude-opus-4-8", count: 1, totals: usageTotals(100) },
          { provider: "openai", model: "gpt-5.5", count: 5, totals: usageTotals(900) },
        ],
        byProvider: [],
        byAgent: [{ agentId: "main", totals: usageTotals(20) }],
        byChannel: [
          { channel: "whatsapp", totals: usageTotals(50) },
          { channel: "telegram", totals: usageTotals(500) },
        ],
        daily: [],
      },
    };
    expect(buildInsights(result)).toEqual({
      topModel: "gpt-5.5",
      messages: 12,
      toolCalls: 9,
      uniqueTools: 3,
      agents: 1,
      sessions: 3,
      sessionsCapped: false,
      topTools: [
        { name: "browser", count: 6 },
        { name: "exec", count: 2 },
        { name: "message", count: 1 },
      ],
      topChannels: [
        { channel: "Telegram", tokens: 500 },
        { channel: "Whatsapp", tokens: 50 },
      ],
      longestSessionMs: 90_000,
    });
  });
});
