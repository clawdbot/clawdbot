/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderSessionsCard, renderUsageInsights } from "./usage-render-overview.ts";
import type { UsageAggregates, UsageSessionEntry, UsageTotals } from "./usageTypes.ts";

const totals: UsageTotals = {
  input: 100,
  output: 40,
  cacheRead: 300,
  cacheWrite: 600,
  totalTokens: 1040,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

const aggregates = {
  messages: {
    total: 4,
    user: 2,
    assistant: 2,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
  tools: {
    totalCalls: 0,
    uniqueTools: 0,
    tools: [],
  },
  byModel: [],
  byProvider: [],
  byAgent: [],
  byChannel: [],
  daily: [],
} as unknown as UsageAggregates;

describe("renderUsageInsights", () => {
  it("includes cache writes in cache-hit-rate denominator", () => {
    const container = document.createElement("div");

    render(
      renderUsageInsights(
        totals,
        aggregates,
        {
          durationSumMs: 0,
          durationCount: 0,
          avgDurationMs: 0,
          errorRate: 0,
        },
        false,
        [],
        1,
        1,
      ),
      container,
    );

    expect(container.textContent).toContain("30.0%");
    expect(container.textContent).toContain("300 cached");
    expect(container.textContent).toContain("1.0K prompt");
  });
});

describe("renderSessionsCard", () => {
  const noop = () => {};

  it("sorts cost by the selected day values when day filters are active", () => {
    const container = document.createElement("div");
    const sessions: UsageSessionEntry[] = [
      {
        key: "all-time-winner",
        label: "All time winner",
        updatedAt: 2,
        usage: {
          ...totals,
          totalCost: 100,
          totalTokens: 100,
          dailyBreakdown: [{ date: "2026-02-05", cost: 1, tokens: 1 }],
        },
      } as UsageSessionEntry,
      {
        key: "day-winner",
        label: "Day winner",
        updatedAt: 1,
        usage: {
          ...totals,
          totalCost: 50,
          totalTokens: 50,
          dailyBreakdown: [{ date: "2026-02-05", cost: 10, tokens: 10 }],
        },
      } as UsageSessionEntry,
    ];

    render(
      renderSessionsCard(
        sessions,
        [],
        ["2026-02-05"],
        false,
        "cost",
        "desc",
        [],
        "all",
        noop,
        noop,
        noop,
        noop,
        [],
        sessions.length,
        noop,
      ),
      container,
    );

    const titles = Array.from(container.querySelectorAll(".session-bar-title")).map((el) =>
      el.textContent?.trim(),
    );
    expect(titles.slice(0, 2)).toEqual(["Day winner", "All time winner"]);
  });
});
