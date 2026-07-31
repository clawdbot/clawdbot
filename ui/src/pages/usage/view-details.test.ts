// Control UI tests cover usage detail behavior through the rendered panel.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import type { SessionLogEntry, TimeSeriesPoint, UsageSessionEntry } from "./types.ts";
import { renderSessionDetailPanel } from "./view-details.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  filters: {
    startDate?: string;
    endDate?: string;
    selectedDays?: string[];
    timeZone?: "local" | "utc";
  } = {},
  errors: {
    timeSeries?: string;
    sessionLogs?: string;
    sessionLogsData?: SessionLogEntry[];
    stale?: boolean;
    onRetryTimeSeries?: () => void;
    onRetrySessionLogs?: () => void;
  } = {},
) {
  const status = (error?: string): PanelRefreshStatus => ({
    error: error ?? null,
    hasLoaded: errors.stale ?? false,
    stale: errors.stale ?? false,
  });
  const container = document.createElement("div");
  render(
    renderSessionDetailPanel(
      session(),
      { points },
      false,
      status(errors.timeSeries),
      errors.onRetryTimeSeries ?? vi.fn(),
      "per-turn",
      vi.fn(),
      breakdownMode,
      vi.fn(),
      start,
      end,
      vi.fn(),
      filters.startDate ?? "",
      filters.endDate ?? "",
      filters.selectedDays ?? [],
      filters.timeZone ?? "local",
      errors.sessionLogsData ?? [],
      false,
      status(errors.sessionLogs),
      errors.onRetrySessionLogs ?? vi.fn(),
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
  it("formats timeline labels in the selected UTC time zone", () => {
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation((_locales, options) =>
      options?.timeZone === "UTC" ? "utc-time" : "local-time",
    );
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation((_locales, options) =>
      options?.timeZone === "UTC" ? "utc-date-time" : "local-date-time",
    );

    const container = mount(
      [
        point({ timestamp: Date.parse("2026-05-13T18:00:00.000Z") }),
        point({ timestamp: Date.parse("2026-05-13T23:59:59.999Z") }),
      ],
      null,
      null,
      "total",
      { timeZone: "utc" },
    );

    expect(
      [...container.querySelectorAll(".ts-axis-label")].map((label) => label.textContent),
    ).toEqual(expect.arrayContaining(["utc-time", "utc-time"]));
    expect(container.querySelector(".ts-bar title")?.textContent).toContain("utc-date-time");
  });

  it("filters detail points by the selected UTC day and keeps the final millisecond", () => {
    const localOffsetMs = 8 * 60 * 60 * 1000;
    const localYear = vi
      .spyOn(Date.prototype, "getFullYear")
      .mockImplementation(function (this: Date) {
        return new Date(this.getTime() + localOffsetMs).getUTCFullYear();
      });
    const localMonth = vi
      .spyOn(Date.prototype, "getMonth")
      .mockImplementation(function (this: Date) {
        return new Date(this.getTime() + localOffsetMs).getUTCMonth();
      });
    const localDay = vi.spyOn(Date.prototype, "getDate").mockImplementation(function (this: Date) {
      return new Date(this.getTime() + localOffsetMs).getUTCDate();
    });
    try {
      const points = [
        point({ timestamp: Date.parse("2026-05-13T18:00:00.000Z") }),
        point({ timestamp: Date.parse("2026-05-13T23:59:59.999Z") }),
      ];
      const filters = {
        startDate: "2026-05-13",
        endDate: "2026-05-13",
        selectedDays: ["2026-05-13"],
      };

      const utc = mount(points, null, null, "total", { ...filters, timeZone: "utc" });
      const local = mount(points, null, null, "total", { ...filters, timeZone: "local" });

      expect(utc.querySelectorAll(".ts-bar")).toHaveLength(2);
      expect(local.querySelectorAll(".ts-bar")).toHaveLength(0);
      expect(local.querySelector(".usage-empty-block")).not.toBeNull();
    } finally {
      localYear.mockRestore();
      localMonth.mockRestore();
      localDay.mockRestore();
    }
  });

  it("ends a local range at the next calendar midnight after a skipped midnight", () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      const container = mount(
        [
          point({ timestamp: new Date(2026, 8, 6, 1).getTime() }),
          point({ timestamp: new Date(2026, 8, 6, 12).getTime() }),
          point({ timestamp: new Date(2026, 8, 7, 0, 30).getTime() }),
        ],
        null,
        null,
        "total",
        { startDate: "2026-09-06", endDate: "2026-09-06", timeZone: "local" },
      );

      expect(container.querySelectorAll(".ts-bar")).toHaveLength(2);
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimeZone;
      }
    }
  });

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

  it("renders independent retry actions for detail request failures", () => {
    const onRetryTimeSeries = vi.fn();
    const onRetrySessionLogs = vi.fn();
    const container = mount(
      [],
      null,
      null,
      "total",
      {},
      {
        timeSeries: "timeline unavailable",
        sessionLogs: "logs unavailable",
        onRetryTimeSeries,
        onRetrySessionLogs,
      },
    );

    const timelineError = container.querySelector<HTMLElement>(".usage-detail-error--timeline");
    const conversationError = container.querySelector<HTMLElement>(
      ".usage-detail-error--conversation",
    );
    expect(timelineError?.textContent).toContain(
      "Could not load usage over time: timeline unavailable",
    );
    expect(conversationError?.textContent).toContain(
      "Could not load conversation: logs unavailable",
    );

    timelineError?.querySelector("button")?.click();
    conversationError?.querySelector("button")?.click();
    expect(onRetryTimeSeries).toHaveBeenCalledOnce();
    expect(onRetrySessionLogs).toHaveBeenCalledOnce();
  });

  it("keeps loaded details visible and marks them stale after refresh failures", () => {
    const container = mount(
      [point({ timestamp: 1000 }), point({ timestamp: 2000 })],
      null,
      null,
      "total",
      {},
      {
        timeSeries: "timeline unavailable",
        sessionLogs: "logs unavailable",
        sessionLogsData: [{ timestamp: 1000, role: "user", content: "retained message" }],
        stale: true,
      },
    );

    expect(container.querySelectorAll(".usage-detail-error--timeline strong")).toHaveLength(1);
    expect(container.querySelectorAll(".usage-detail-error--conversation strong")).toHaveLength(1);
    expect(container.querySelector(".timeseries-svg")).not.toBeNull();
    expect(container.textContent).toContain("retained message");
    expect(container.textContent).toContain("Showing stale data");
  });
});
