/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostDailyEntry, UsageAggregates, UsageSessionEntry, UsageTotals } from "./types.ts";
import {
  renderDailyChartCompact,
  renderCostWindowComparison,
  renderSessionsCard,
  renderUsageInsights,
} from "./view-overview.ts";

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

function dailyEntry(date: string, totalTokens: number, totalCost = 0): CostDailyEntry {
  return {
    ...totals,
    date,
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
  };
}

function renderDailyChart(
  daily: CostDailyEntry[],
  onSelectDay = vi.fn<(day: string, shiftKey: boolean) => void>(),
) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderDailyChartCompact(daily, [], "tokens", "total", () => {}, onSelectDay),
    container,
  );
  return {
    container,
    onSelectDay,
    bars: Array.from(container.querySelectorAll<HTMLElement>(".daily-bar-wrapper")),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function directText(element: Element | null | undefined): string | undefined {
  return Array.from(element?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function getSummaryCards(container: HTMLElement): Array<{
  title: string | undefined;
  value: string | undefined;
  sub: string | undefined;
}> {
  return Array.from(container.querySelectorAll(".usage-summary-card")).map((card) => ({
    title: directText(card.querySelector(".usage-summary-title")),
    value: card.querySelector(".usage-summary-value")?.textContent?.trim(),
    sub: card.querySelector(".usage-summary-sub")?.textContent?.trim(),
  }));
}

describe("renderUsageInsights", () => {
  it("renders overview hints as focusable tooltip anchors", () => {
    const container = document.createElement("div");
    document.body.append(container);

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
        true,
        [],
        1,
        1,
      ),
      container,
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.usage-summary-hint")];
    const tooltips = [...container.querySelectorAll("openclaw-tooltip")];
    expect(buttons).toHaveLength(9);
    expect(tooltips).toHaveLength(9);
    expect(
      buttons.every(
        (button) =>
          button.type === "button" &&
          !button.hasAttribute("title") &&
          Boolean(button.getAttribute("aria-label")),
      ),
    ).toBe(true);
    expect(
      tooltips.every((tooltip) => {
        const button = tooltip.querySelector<HTMLButtonElement>("button.usage-summary-hint");
        const content = tooltip.querySelector('[slot="content"]');
        return Boolean(
          button &&
          buttons.includes(button) &&
          content &&
          button.getAttribute("aria-label") !== content.textContent,
        );
      }),
    ).toBe(true);

    buttons[0]?.click();
    expect(document.activeElement).toBe(buttons[0]);
  });

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
        true,
        [],
        1,
        1,
      ),
      container,
    );

    expect(getSummaryCards(container).filter((card) => card.title === "Cache Hit Rate")).toEqual([
      {
        title: "Cache Hit Rate",
        value: "30.0%",
        sub: "300 cached · 1.0K prompt",
      },
    ]);
  });

  it("shows provider cost share when cost data is available", () => {
    const container = document.createElement("div");
    const costTotals = { ...totals, totalCost: 10 };
    const costAggregates = {
      ...aggregates,
      byProvider: [
        {
          provider: "openai",
          count: 3,
          totals: { ...totals, totalCost: 7, totalTokens: 700 },
        },
      ],
    } as UsageAggregates;

    render(
      renderUsageInsights(
        costTotals,
        costAggregates,
        {
          durationSumMs: 0,
          durationCount: 0,
          avgDurationMs: 0,
          errorRate: 0,
        },
        false,
        true,
        [],
        1,
        1,
      ),
      container,
    );

    const providerCard = Array.from(container.querySelectorAll(".usage-insight-card")).find(
      (card) => card.querySelector(".usage-insight-title")?.textContent === "Top Providers",
    );
    expect(providerCard?.textContent).toContain("70.0% of cost");
  });

  it("omits cost shares when category totals are not day-scoped", () => {
    const container = document.createElement("div");
    const costTotals = { ...totals, totalCost: 1 };
    const costAggregates = {
      ...aggregates,
      byProvider: [
        {
          provider: "openai",
          count: 3,
          totals: { ...totals, totalCost: 10, totalTokens: 700 },
        },
      ],
    } as UsageAggregates;

    render(
      renderUsageInsights(
        costTotals,
        costAggregates,
        {
          durationSumMs: 0,
          durationCount: 0,
          avgDurationMs: 0,
          errorRate: 0,
        },
        false,
        false,
        [],
        1,
        1,
      ),
      container,
    );

    expect(container.textContent).not.toContain("1000.0% of cost");
  });
});

describe("renderDailyChartCompact", () => {
  it("keeps day selection operable with mouse and keyboard", () => {
    const { bars, onSelectDay } = renderDailyChart([dailyEntry("2026-05-04", 500, 0.2)]);
    const bar = expectDefined(bars[0], "daily usage bar");

    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true);

    bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false);

    const space = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
      shiftKey: true,
    });
    bar.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true);
  });

  it("labels the chart scale with the selected metric", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 1), dailyEntry("2026-05-04", 1_000, 2)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$2.00", "$1.00", "$0.00"]);
    expect(container.querySelector(".daily-chart-scale-badge")).toBeNull();
  });

  it("labels the true midpoint of a compressed chart scale", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 1), dailyEntry("2026-05-04", 1_000, 100)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$100.00", "$25.00", "$0.00"]);
    expect(container.querySelector(".daily-chart-scale-badge")?.textContent?.trim()).toBe("√");
  });

  it("preserves sub-cent values in chart scale labels", () => {
    const container = document.createElement("div");
    render(
      renderDailyChartCompact(
        [dailyEntry("2026-05-03", 500, 0.004), dailyEntry("2026-05-04", 1_000, 0.008)],
        [],
        "cost",
        "total",
        () => {},
        () => {},
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$0.0080", "$0.0040", "$0.00"]);
  });

  it("normalizes a nonzero micro-cost bar to the labeled maximum", () => {
    const container = document.createElement("div");
    const microCostDay = {
      ...dailyEntry("2026-05-04", 1_000, 0.00001),
      inputCost: 0.000004,
      outputCost: 0.000006,
    };
    render(
      renderDailyChartCompact(
        [microCostDay],
        [],
        "cost",
        "by-type",
        () => {},
        () => {},
      ),
      container,
    );

    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["$0.000010", "$0.000005", "$0.00"]);
    expect(container.querySelector<HTMLElement>(".daily-bar")?.style.height).toBe("200px");
    expect(container.querySelector(".daily-bar-total")?.textContent?.trim()).toBe("$0.000010");
    const tooltip = container.querySelector<HTMLElement & { content: string }>("openclaw-tooltip");
    expect(tooltip?.content).toContain("$0.000010");
    expect(tooltip?.content).toContain("Output $0.000006");
    expect(tooltip?.content).toContain("Input $0.000004");
    expect(container.querySelector(".daily-chart-scale-badge")).toBeNull();
  });

  it("reserves the totals row when dense ranges hide bar totals", () => {
    const container = document.createElement("div");
    const daily = Array.from({ length: 15 }, (_, index) =>
      dailyEntry(`2026-05-${String(index + 1).padStart(2, "0")}`, 1_000, index + 1),
    );
    render(
      renderDailyChartCompact(
        daily,
        [],
        "cost",
        "total",
        () => {},
        () => {},
      ),
      container,
    );

    expect(container.querySelectorAll(".daily-bar-total--placeholder")).toHaveLength(15);
  });
});

describe("renderCostWindowComparison", () => {
  it("shows the selected range and shorter calendar periods", () => {
    const container = document.createElement("div");
    render(
      renderCostWindowComparison(
        [
          dailyEntry("2026-06-01", 100, 1),
          dailyEntry("2026-06-25", 400, 4),
          dailyEntry("2026-07-01", 500, 5),
        ],
        "2026-06-01",
        "2026-07-01",
      ),
      container,
    );

    const cards = Array.from(container.querySelectorAll(".cost-window-card")).map((card) => ({
      label: card.querySelector(".cost-window-card__label")?.textContent?.trim(),
      value: card.querySelector(".cost-window-card__value")?.textContent?.trim(),
    }));
    expect(cards).toEqual([
      { label: "Selected Range", value: "$10.00" },
      { label: "Jul 1", value: "$5.00" },
      { label: "Last 7 days", value: "$9.00" },
      { label: "Last 30 days", value: "$9.00" },
    ]);
  });

  it("preserves sub-cent totals and daily averages", () => {
    const container = document.createElement("div");
    render(
      renderCostWindowComparison(
        [dailyEntry("2026-07-01", 300, 0.003)],
        "2026-06-02",
        "2026-07-01",
      ),
      container,
    );

    const range = container.querySelector(".cost-window-card--range");
    expect(range?.querySelector(".cost-window-card__value")?.textContent?.trim()).toBe("$0.0030");
    expect(range?.querySelector(".cost-window-card__meta")?.textContent).toContain("$0.0001 / day");
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
