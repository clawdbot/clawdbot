// Control UI tests cover usage detail behavior through the rendered panel.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TimeSeriesPoint, UsageSessionEntry } from "./types.ts";
import { renderSessionDetailPanel } from "./view-details.ts";

function point(overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    timestamp: 1000,
    totalTokens: 100,
    cost: 0.1,
    input: 30,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cumulativeTokens: 100,
    cumulativeCost: 0.1,
    ...overrides,
  };
}

function session(): UsageSessionEntry {
  return {
    key: "agent:main:detail",
    label: "Detail session",
    usage: {
      totalTokens: 1000,
      totalCost: 1,
      input: 300,
      output: 400,
      cacheRead: 200,
      cacheWrite: 100,
      inputCost: 0.3,
      outputCost: 0.4,
      cacheReadCost: 0.2,
      cacheWriteCost: 0.1,
      durationMs: 60_000,
      firstActivity: 0,
      lastActivity: 60_000,
      missingCostEntries: 0,
      messageCounts: {
        total: 10,
        user: 5,
        assistant: 5,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
    },
  } as UsageSessionEntry;
}

function mount(
  points: TimeSeriesPoint[],
  start: number | null,
  end: number | null,
  breakdownMode: "total" | "by-type" = "total",
) {
  const container = document.createElement("div");
  render(
    renderSessionDetailPanel(
      session(),
      { points },
      false,
      "per-turn",
      vi.fn(),
      breakdownMode,
      vi.fn(),
      start,
      end,
      vi.fn(),
      "",
      "",
      [],
      [],
      false,
      false,
      vi.fn(),
      { roles: [], tools: [], hasTools: false, query: "" },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      false,
      vi.fn(),
      vi.fn(),
    ),
    container,
  );
  return container;
}

describe("renderSessionDetailPanel filtered usage", () => {
  it("aggregates token, cost, type, message, and duration data inside the selected range", () => {
    const container = mount(
      [
        point({
          timestamp: 1000,
          totalTokens: 100,
          cost: 0.1,
          input: 10,
          output: 0,
          cacheRead: 5,
          cacheWrite: 2,
        }),
        point({
          timestamp: 2000,
          totalTokens: 200,
          cost: 0.2,
          input: 0,
          output: 20,
          cacheRead: 7,
          cacheWrite: 3,
        }),
        point({ timestamp: 3000, totalTokens: 300, cost: 0.3 }),
      ],
      1000,
      2000,
      "by-type",
    );

    expect(container.querySelector(".session-detail-stats")?.textContent).toContain("300");
    expect(container.querySelector(".session-detail-stats")?.textContent).toContain("$0.30");
    expect(container.querySelector(".session-detail-indicator")).not.toBeNull();
    const summary = [...container.querySelectorAll(".session-summary-card")];
    expect(summary[0]?.textContent).toContain("2");
    const messageSummary = summary[0]?.textContent?.replaceAll(/\s+/g, " ");
    expect(messageSummary).toContain("1 user");
    expect(messageSummary).toContain("1 assistant");
    expect(summary[3]?.textContent).toContain("1s");
    expect(
      [...container.querySelectorAll(".timeseries-breakdown .legend-item")].map((item) =>
        item.textContent?.replaceAll(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Output 20", "Input 10", "Cache Write 5", "Cache Read 12"]);
    expect(
      container.querySelector(".timeseries-breakdown .cost-breakdown-total")?.textContent,
    ).toContain("47");
  });

  it("accepts a reversed range and falls back to full totals when no points match", () => {
    const reversed = mount(
      [point({ timestamp: 1000, totalTokens: 50 }), point({ timestamp: 2000, totalTokens: 75 })],
      2000,
      1000,
    );
    expect(reversed.querySelector(".session-detail-stats")?.textContent).toContain("125");

    const empty = mount([point({ timestamp: 1000 })], 3000, 4000);
    expect(empty.querySelector(".session-detail-stats")?.textContent).toContain("1.0K");
    expect(empty.querySelector(".session-detail-indicator")).toBeNull();
  });

  it("never renders Invalid Date for out-of-range point timestamps", () => {
    const container = mount(
      [point({ timestamp: 8_640_000_000_000_001 }), point({ timestamp: 8_640_000_000_000_002 })],
      null,
      null,
    );
    expect(container.textContent).not.toContain("Invalid Date");
  });
});
