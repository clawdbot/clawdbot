/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildAggregatesFromSessions } from "./metrics.ts";
import type { UsageProps, UsageSessionEntry, UsageTotals } from "./types.ts";
import { renderUsage } from "./view.ts";

const noop = vi.fn();

function usageSession(
  key: string,
  agentId: string,
  provider: string,
  totalsOverrides: Partial<UsageTotals> = {},
): UsageSessionEntry {
  const totals: UsageTotals = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    totalCost: 1,
    inputCost: 0.8,
    outputCost: 0.2,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...totalsOverrides,
  };
  return {
    key,
    label: `${agentId} session`,
    agentId,
    modelProvider: provider,
    model: `${provider}-model`,
    updatedAt: Date.now(),
    usage: {
      ...totals,
      messageCounts: {
        total: 2,
        user: 1,
        assistant: 1,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      modelUsage: [{ provider, model: `${provider}-model`, count: 1, totals }],
    },
  };
}

function insightCard(container: ParentNode, title: string): Element | undefined {
  return Array.from(container.querySelectorAll(".usage-insight-card")).find(
    (card) => card.querySelector(".usage-insight-title")?.textContent === title,
  );
}

function createUsageProps(overrides: Partial<UsageProps> = {}): UsageProps {
  return {
    data: {
      loading: false,
      exporting: false,
      error: null,
      sessions: [],
      agents: [],
      sessionsLimitReached: false,
      totals: null,
      aggregates: null,
      costDaily: [],
      cacheRefresh: "complete",
      providerUsage: [],
      providerUsageStalled: false,
      providerUsageUnavailable: false,
    },
    filters: {
      startDate: "2026-05-14",
      endDate: "2026-05-14",
      scope: "family",
      selectedSessions: [],
      selectedDays: [],
      selectedHours: [],
      agentId: null,
      query: "",
      queryDraft: "",
      timeZone: "local",
    },
    display: {
      chartMode: "tokens",
      dailyChartMode: "total",
      sessionSort: "tokens",
      sessionSortDir: "desc",
      recentSessions: [],
      sessionsTab: "all",
      visibleColumns: [],
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      context: {
        weight: undefined,
        loading: false,
        status: { error: null, hasLoaded: false, stale: false },
      },
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesStatus: { error: null, hasLoaded: false, stale: false },
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsStatus: { error: null, hasLoaded: false, stale: false },
      sessionLogsExpanded: false,
      logFilters: {
        roles: [],
        tools: [],
        hasTools: false,
        query: "",
      },
    },
    callbacks: {
      filters: {
        onStartDateChange: noop,
        onEndDateChange: noop,
        onScopeChange: noop,
        onAgentChange: noop,
        onRefresh: noop,
        onTimeZoneChange: noop,
        onToggleHeaderPinned: noop,
        onSelectDay: noop,
        onSelectHour: noop,
        onClearDays: noop,
        onClearHours: noop,
        onClearSessions: noop,
        onClearFilters: noop,
        onQueryDraftChange: noop,
        onApplyQuery: noop,
        onClearQuery: noop,
      },
      display: {
        onExportJson: noop,
        onChartModeChange: noop,
        onDailyChartModeChange: noop,
        onSessionSortChange: noop,
        onSessionSortDirChange: noop,
        onSessionsTabChange: noop,
        onToggleColumn: noop,
      },
      details: {
        onToggleContextExpanded: noop,
        onToggleSessionLogsExpanded: noop,
        onLogFilterRolesChange: noop,
        onLogFilterToolsChange: noop,
        onLogFilterHasToolsChange: noop,
        onLogFilterQueryChange: noop,
        onLogFilterClear: noop,
        onSelectSession: noop,
        onTimeSeriesModeChange: noop,
        onTimeSeriesBreakdownChange: noop,
        onTimeSeriesCursorRangeChange: noop,
        onRetryTimeSeries: noop,
        onRetrySessionLogs: noop,
        onRetryContextWeight: noop,
      },
    },
    ...overrides,
  };
}

it("renders shared skeletons while initial usage is loading", () => {
  const container = document.createElement("div");
  const props = createUsageProps();
  render(renderUsage(createUsageProps({ data: { ...props.data, loading: true } })), container);

  const blocks = container.querySelectorAll(".usage-skeleton-block");
  expect(blocks).toHaveLength(3);
  expect([...blocks].every((block) => block.classList.contains("skeleton"))).toBe(true);
});

describe("renderUsage", () => {
  it("surfaces a provider-usage failure instead of hiding the panel", () => {
    const container = document.createElement("div");
    const base = createUsageProps();
    render(
      renderUsage(createUsageProps({ data: { ...base.data, providerUsageUnavailable: true } })),
      container,
    );

    expect(container.textContent).toContain(
      "Provider usage is unavailable; the last request failed. Refresh to retry.",
    );
  });

  it("keeps the provider panel hidden when usage is empty without a failure", () => {
    const container = document.createElement("div");
    render(renderUsage(createUsageProps()), container);

    expect(container.textContent).not.toContain("Provider usage is unavailable");
  });

  it("keeps pending sessions on their selected local or UTC activity day", () => {
    const localOffsetMs = -7 * 60 * 60 * 1000;
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
      const pendingSession = {
        key: "agent:main:pending-cache",
        label: "Pending cache",
        agentId: "main",
        updatedAt: Date.parse("2026-05-14T00:30:00.000Z"),
        usage: null,
      } satisfies UsageSessionEntry;

      for (const { timeZone, selectedDay, visible } of [
        { timeZone: "utc", selectedDay: "2026-05-14", visible: true },
        { timeZone: "local", selectedDay: "2026-05-13", visible: true },
        { timeZone: "local", selectedDay: "2026-05-14", visible: false },
      ] as const) {
        const container = document.createElement("div");
        render(
          renderUsage(
            createUsageProps({
              data: { ...createUsageProps().data, sessions: [pendingSession] },
              filters: {
                ...createUsageProps().filters,
                selectedDays: [selectedDay],
                timeZone,
              },
            }),
          ),
          container,
        );

        expect(container.querySelector(".session-bar-row") !== null).toBe(visible);
      }
    } finally {
      localYear.mockRestore();
      localMonth.mockRestore();
      localDay.mockRestore();
    }
  });

  it("keeps insight aggregates scoped to the selected agent", () => {
    const container = document.createElement("div");
    const sessions = [
      usageSession("agent:main:main", "main", "openai"),
      usageSession("agent:research:main", "research", "anthropic"),
    ];

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            sessions,
            totals: sessions[0]?.usage ?? null,
            aggregates: buildAggregatesFromSessions(sessions),
          },
          filters: { ...createUsageProps().filters, agentId: "research" },
        }),
      ),
      container,
    );

    const providers = insightCard(container, "Top Providers");
    expect(providers?.textContent).toContain("anthropic");
    expect(providers?.textContent).not.toContain("openai");
  });

  it("does not fall back to global insights when a query matches no sessions", () => {
    const container = document.createElement("div");
    const sessions = [usageSession("agent:main:main", "main", "openai")];

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            sessions,
            totals: sessions[0]?.usage ?? null,
            aggregates: buildAggregatesFromSessions(sessions),
          },
          filters: {
            ...createUsageProps().filters,
            query: "missing-session",
            queryDraft: "missing-session",
          },
        }),
      ),
      container,
    );

    const providers = insightCard(container, "Top Providers");
    expect(providers?.textContent).toContain("No provider data");
    expect(providers?.textContent).not.toContain("openai");
  });

  it.each(["session", "day"] as const)(
    "preserves missing-cost attribution in %s-filtered JSON exports",
    (filter) => {
      const base = createUsageProps();
      const missing = { missingCostEntries: 2, missingCostByModel: { "fixture/unpriced": 2 } };
      const session = usageSession("agent:main:priced", "main", "fixture", missing);
      const totals = session.usage;
      if (!totals) {
        throw new Error("usage session fixture must include totals");
      }
      const onExportJson = vi.fn();
      const container = document.createElement("div");
      render(
        renderUsage(
          createUsageProps({
            data: {
              ...base.data,
              sessions: [session],
              costDaily: [{ ...totals, date: "2026-05-14" }],
            },
            filters: {
              ...base.filters,
              selectedSessions: filter === "session" ? [session.key] : [],
              selectedDays: filter === "day" ? ["2026-05-14"] : [],
            },
            callbacks: { ...base.callbacks, display: { ...base.callbacks.display, onExportJson } },
          }),
        ),
        container,
      );
      container
        .querySelector(".usage-export-menu")
        ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
      expect(onExportJson).toHaveBeenCalledOnce();
      expect(onExportJson.mock.calls[0]?.[0]).toMatchObject({ totals: missing });
    },
  );

  it("keeps selected session labels on UTF-16 boundaries", () => {
    const container = document.createElement("div");
    const label = `${"a".repeat(19)}🚀${"b".repeat(28)}🚀tail`;
    const session = {
      key: "agent:main:emoji",
      label,
      agentId: "main",
      updatedAt: Date.now(),
      usage: {
        input: 1,
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
    } satisfies UsageProps["data"]["sessions"][number];

    render(
      renderUsage(
        createUsageProps({
          data: { ...createUsageProps().data, sessions: [session] },
          filters: {
            ...createUsageProps().filters,
            selectedSessions: [session.key],
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".filter-chip-label")?.textContent).toContain(
      `${"a".repeat(19)}…`,
    );
    expect(container.querySelector(".session-detail-title")?.textContent?.trim()).toBe(
      `${"a".repeat(19)}🚀${"b".repeat(28)}…`,
    );
  });

  it("omits the duplicate inner page heading because the shell owns tab headings", () => {
    const container = document.createElement("div");

    render(renderUsage(createUsageProps()), container);

    expect(container.querySelector(".usage-page-header")).toBeNull();
    expect(container.querySelector(".usage-page-title")).toBeNull();
    expect(container.querySelector(".usage-header")).not.toBeNull();
  });

  it("leaves agent scoping to the shared page header control", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            agents: ["main", "research"],
            sessions: [
              {
                key: "agent:main:main",
                agentId: "main",
                lastUpdated: Date.now(),
                usage: null,
              } as UsageProps["data"]["sessions"][number],
            ],
          },
        }),
      ),
      container,
    );

    expect(container.querySelector('input[name="usage-agent-scope"]')).toBeNull();
  });

  it("keeps filter option values distinct from menu commands", () => {
    const container = document.createElement("div");
    const onQueryDraftChange = vi.fn();
    const session = usageSession("agent:main:main", "main", "clear");
    const props = createUsageProps({
      data: {
        ...createUsageProps().data,
        sessions: [session],
        aggregates: buildAggregatesFromSessions([session]),
      },
    });
    props.callbacks.filters.onQueryDraftChange = onQueryDraftChange;

    render(renderUsage(props), container);
    const option = [...container.querySelectorAll("wa-dropdown-item")].find(
      (item) => item.textContent?.trim() === "clear",
    )!;
    option.checked = true;
    option
      ?.closest("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: option }, bubbles: true }));

    expect(onQueryDraftChange).toHaveBeenCalledWith(expect.stringContaining("provider:clear"));
  });

  it("reports a stalled provider refresh instead of hiding the section", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            providerUsage: [],
            providerUsageStalled: true,
          },
        }),
      ),
      container,
    );

    const callout = container.querySelector(".usage-callout");
    expect(callout?.textContent?.trim()).toBe(
      "Provider usage did not finish loading. Refresh to retry.",
    );
  });

  it("keeps available provider usage visible when refresh stalls", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            providerUsage: [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [{ label: "Weekly", usedPercent: 25 }],
              },
            ],
            providerUsageStalled: true,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".usage-callout")?.textContent).toContain(
      "Provider usage did not finish loading",
    );
    const card = container.querySelector(".provider-usage-card");
    expect(card?.textContent).toContain("OpenAI");
    expect(card?.textContent).toContain("Weekly");
  });

  it("renders provider plans, quotas, and billing independently of session usage", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            providerUsage: [
              {
                provider: "openrouter",
                displayName: "OpenRouter",
                plan: "Production",
                windows: [{ label: "API key budget", usedPercent: 25 }],
                billing: [
                  {
                    type: "balance",
                    label: "Account balance",
                    amount: 64.5,
                    unit: "USD",
                  },
                  {
                    type: "budget",
                    label: "API key budget",
                    used: 5,
                    limit: 20,
                    unit: "USD",
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );

    const card = container.querySelector(".provider-usage-card");
    expect(card?.textContent).toContain("OpenRouter");
    expect(card?.textContent).toContain("Production");
    expect(card?.textContent).toContain("75% left");
    expect(card?.textContent).toContain("$64.50");
    expect(card?.textContent).toContain("$5.00 / $20.00");
  });

  it("renders provider-reported cost history and attribution", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            providerUsage: [
              {
                provider: "openai",
                displayName: "OpenAI",
                plan: "Admin API",
                windows: [],
                costHistory: {
                  unit: "USD",
                  periodDays: 30,
                  daily: [
                    {
                      date: new Date().toISOString().slice(0, 10),
                      amount: 12.5,
                      requests: 42,
                      inputTokens: 1_000,
                      cacheReadTokens: 400,
                      cacheWriteTokens: 0,
                      outputTokens: 250,
                      totalTokens: 1_250,
                    },
                    {
                      date: "2026-01-01",
                      amount: 0,
                      requests: 1,
                      inputTokens: 50,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                      outputTokens: 10,
                      totalTokens: 60,
                    },
                  ],
                  models: [
                    {
                      name: "gpt-5.5",
                      requests: 42,
                      inputTokens: 1_000,
                      cacheReadTokens: 400,
                      cacheWriteTokens: 0,
                      outputTokens: 250,
                      totalTokens: 1_250,
                    },
                  ],
                  categories: [{ name: "Responses", amount: 12.5 }],
                },
              },
            ],
          },
        }),
      ),
      container,
    );

    const card = container.querySelector(".provider-usage-card");
    expect(card?.textContent).toContain("$12.50");
    expect(card?.textContent).toContain("43 requests");
    expect(card?.textContent).toContain("gpt-5.5");
    expect(card?.textContent).toContain("Responses");
    const bars = card?.querySelectorAll<HTMLElement>(".provider-cost-chart span");
    expect(bars).toHaveLength(2);
    expect(bars?.[0]?.style.height).toBe("100%");
    expect(bars?.[1]?.style.height).toBe("0%");
  });

  it("filters visible sessions when an agent scope is selected", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            agents: ["main", "research"],
            sessions: [
              {
                key: "agent:main:main",
                agentId: "main",
                lastUpdated: Date.now(),
                usage: {
                  totalTokens: 10,
                  totalCost: 0,
                } as UsageProps["data"]["sessions"][number]["usage"],
              } as UsageProps["data"]["sessions"][number],
              {
                key: "agent:research:main",
                agentId: "research",
                lastUpdated: Date.now(),
                usage: {
                  totalTokens: 20,
                  totalCost: 0,
                } as UsageProps["data"]["sessions"][number]["usage"],
              } as UsageProps["data"]["sessions"][number],
            ],
          },
          filters: {
            ...createUsageProps().filters,
            agentId: "research",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("agent:research:main");
    expect(container.textContent).not.toContain("agent:main:main");
  });

  it("keeps session-derived insights scoped to the visible page when the page limit is hit", () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            sessionsLimitReached: true,
            totals: {
              input: 1_000,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1_000,
              totalCost: 10,
              inputCost: 10,
              outputCost: 0,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 0,
            },
            aggregates: {
              messages: {
                total: 100,
                user: 50,
                assistant: 50,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
              tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
              byModel: [],
              byProvider: [],
              byAgent: [],
              byChannel: [],
              daily: [],
            },
            sessions: [
              {
                key: "agent:main:visible",
                agentId: "main",
                lastUpdated: Date.now(),
                usage: {
                  input: 10,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 10,
                  totalCost: 0.1,
                  inputCost: 0.1,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                  messageCounts: {
                    total: 2,
                    user: 1,
                    assistant: 1,
                    toolCalls: 0,
                    toolResults: 0,
                    errors: 0,
                  },
                },
              } as UsageProps["data"]["sessions"][number],
            ],
          },
        }),
      ),
      container,
    );

    const messagesValue = container.querySelector(
      ".usage-overview-card .usage-summary-card--hero .usage-summary-value",
    );
    expect(messagesValue?.textContent?.trim()).toBe("2");
  });

  it("hides range-wide cost windows when a post-load filter is active", () => {
    const base = createUsageProps();
    const totals = {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      totalCost: 1,
      inputCost: 1,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const data = {
      ...base.data,
      totals,
      costDaily: [{ ...totals, date: "2026-05-14" }],
    };
    const filterCases: Array<Partial<UsageProps["filters"]>> = [
      { query: "provider:openai" },
      { agentId: "main" },
      { selectedDays: ["2026-05-14"] },
      { selectedHours: [12] },
      { selectedSessions: ["agent:main:main"] },
    ];

    const unfiltered = document.createElement("div");
    render(renderUsage(createUsageProps({ data })), unfiltered);
    expect(unfiltered.querySelector(".cost-window-analysis")).not.toBeNull();

    for (const filterCase of filterCases) {
      const container = document.createElement("div");
      render(
        renderUsage(
          createUsageProps({
            data,
            filters: { ...base.filters, ...filterCase },
          }),
        ),
        container,
      );
      expect(container.querySelector(".cost-window-analysis")).toBeNull();
    }
  });

  it("shows the empty state for an all-zero successful response", () => {
    const zeroTotals = {
      totalTokens: 0,
      totalCost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      missingCostEntries: 0,
    };
    const container = document.createElement("div");
    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            // The gateway always returns a totals object, even with no usage.
            totals: zeroTotals as UsageProps["data"]["totals"],
          },
        }),
      ),
      container,
    );
    expect(container.querySelector(".usage-empty-state")).not.toBeNull();
  });

  it("does not render the empty state under an error callout", () => {
    const container = document.createElement("div");
    render(
      renderUsage(
        createUsageProps({
          data: {
            ...createUsageProps().data,
            error: "usage failed",
          },
        }),
      ),
      container,
    );
    expect(container.querySelector(".usage-callout")).not.toBeNull();
    expect(container.querySelector(".usage-empty-state")).toBeNull();
  });
});
