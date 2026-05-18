/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderDailyChartCompact,
  renderSessionsCard,
  renderUsageInsights,
} from "./usage-render-overview.ts";
import type {
  CostDailyEntry,
  UsageAggregates,
  UsageSessionEntry,
  UsageTotals,
} from "./usageTypes.ts";

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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function mockTooltipRect(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("daily-bar-tooltip--floating")) {
        return rect(0, 0, width, height);
      }
      return rect(0, 0, 0, 0);
    },
  );
}

function mockElementRect(
  element: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(left, top, width, height),
  });
}

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

function getFloatingTooltip(): HTMLElement | null {
  return document.body.querySelector(".daily-bar-tooltip--floating");
}

afterEach(() => {
  document.body.replaceChildren();
  window.dispatchEvent(new Event("scroll"));
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

    expect(getSummaryCards(container).filter((card) => card.title === "Cache Hit Rate")).toEqual([
      {
        title: "Cache Hit Rate",
        value: "30.0%",
        sub: "300 cached · 1.0K prompt",
      },
    ]);
  });
});

describe("renderDailyChartCompact", () => {
  it("shows one floating tooltip for tall and short daily bars and hides it on mouse leave", () => {
    setViewport(800, 600);
    mockTooltipRect(180, 64);
    const { bars } = renderDailyChart([
      dailyEntry("2026-05-01", 1_200_000, 3.5),
      dailyEntry("2026-05-02", 4, 0.01),
    ]);

    mockElementRect(bars[0], 100, 100, 24, 200);
    bars[0].dispatchEvent(new MouseEvent("mouseenter"));

    let tooltip = getFloatingTooltip();
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain("1.2M tokens");
    expect(tooltip?.style.top).toBe("28px");
    expect(document.body.querySelectorAll(".daily-bar-tooltip--floating")).toHaveLength(1);

    bars[0].dispatchEvent(new MouseEvent("mouseleave"));
    expect(getFloatingTooltip()).toBeNull();

    mockElementRect(bars[1], 200, 320, 24, 6);
    bars[1].dispatchEvent(new MouseEvent("mouseenter"));

    tooltip = getFloatingTooltip();
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain("4 tokens");
    bars[1].dispatchEvent(new MouseEvent("mouseleave"));
  });

  it("flips below when the bar is near the top and clamps inside a narrow viewport", () => {
    setViewport(120, 140);
    mockTooltipRect(100, 40);
    const { bars } = renderDailyChart([dailyEntry("2026-05-03", 10_000, 1)]);

    mockElementRect(bars[0], 110, 12, 20, 20);
    bars[0].dispatchEvent(new MouseEvent("mouseenter"));

    const tooltip = getFloatingTooltip();
    expect(tooltip?.dataset.placement).toBe("below");
    expect(tooltip?.style.top).toBe("40px");
    expect(tooltip?.style.left).toBe("12px");
    bars[0].dispatchEvent(new MouseEvent("mouseleave"));
  });

  it("clears the floating tooltip when the chart DOM is removed", async () => {
    setViewport(800, 600);
    mockTooltipRect(160, 56);
    const { bars, container } = renderDailyChart([dailyEntry("2026-05-04", 500, 0.2)]);
    mockElementRect(bars[0], 300, 220, 24, 80);

    bars[0].dispatchEvent(new MouseEvent("mouseenter"));
    expect(getFloatingTooltip()).not.toBeNull();

    container.remove();
    await Promise.resolve();
    expect(getFloatingTooltip()).toBeNull();
  });

  it("shows on keyboard focus, hides on blur, and keeps day selection operable", () => {
    setViewport(800, 600);
    mockTooltipRect(160, 56);
    const { bars, onSelectDay } = renderDailyChart([dailyEntry("2026-05-04", 500, 0.2)]);
    mockElementRect(bars[0], 300, 220, 24, 80);

    bars[0].dispatchEvent(new Event("focus"));
    expect(getFloatingTooltip()?.textContent).toContain("500 tokens");

    bars[0].dispatchEvent(new Event("blur"));
    expect(getFloatingTooltip()).toBeNull();

    bars[0].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true);

    bars[0].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false);

    const space = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
      shiftKey: true,
    });
    bars[0].dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true);

    bars[0].dispatchEvent(new MouseEvent("mouseenter"));
    bars[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    bars[0].dispatchEvent(new Event("focus"));
    bars[0].dispatchEvent(new MouseEvent("mouseleave"));
    expect(getFloatingTooltip()).toBeNull();
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
