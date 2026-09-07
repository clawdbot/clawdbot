/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildAggregatesFromSessions } from "./metrics.ts";
import { buildUsageFilterOptions } from "./query.ts";
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
        status: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      },
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
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
      },
    },
    ...overrides,
  };
}

it.each([
  { query: "provider:openai" },
  { agentId: "main" },
  { selectedSessions: ["agent:main:matched"] },
  { selectedSessions: ["agent:main:matched", "agent:main:earlier"] },
  { query: "provider:openai", selectedHours: [12] },
])("intersects selected days with the session scope %j", (scope) => {
  const base = createUsageProps();
  const matched = usageSession("agent:main:matched", "main", "openai", {
    totalTokens: 800,
    totalCost: 80,
  });
  const other = usageSession("agent:other:other", "other", "anthropic", {
    totalTokens: 900,
    totalCost: 90,
  });
  const selectedDay = {
    date: "2026-05-14",
    tokens: 99,
    cost: 10,
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 99,
    totalCost: 10,
    inputCost: 1,
    outputCost: 2,
    cacheReadCost: 3,
    cacheWriteCost: 4,
    missingCostEntries: 1,
    missingCostByModel: { "openai/unpriced": 1 },
  };
  matched.usage!.activityDates = ["2026-05-13", "2026-05-14"];
  matched.usage!.firstActivity = Date.UTC(2026, 4, 14, 12);
  matched.usage!.lastActivity = matched.usage!.firstActivity;
  matched.usage!.dailyBreakdown = [
    { ...selectedDay, date: "2026-05-13", tokens: 701, cost: 70, totalTokens: 701, totalCost: 70 },
    selectedDay,
  ];
  other.usage!.activityDates = ["2026-05-14"];
  other.usage!.dailyBreakdown = [
    { ...selectedDay, tokens: 900, cost: 90, totalTokens: 900, totalCost: 90 },
  ];
  const earlier = usageSession("agent:main:earlier", "main", "openai", { totalCost: 5 });
  earlier.usage!.activityDates = ["2026-05-13"];
  earlier.usage!.firstActivity = Date.UTC(2026, 4, 13, 12);
  earlier.usage!.lastActivity = earlier.usage!.firstActivity;
  earlier.usage!.dailyBreakdown = [
    {
      ...selectedDay,
      date: "2026-05-13",
      tokens: 50,
      cost: 5,
      totalTokens: 50,
      totalCost: 5,
    },
  ];
  const onExportJson = vi.fn();
  const container = document.createElement("div");
  render(
    renderUsage(
      createUsageProps({
        data: {
          ...base.data,
          sessions: [matched, other, earlier],
          totals: { ...selectedDay, totalCost: 170 },
          costDaily: [{ ...selectedDay, totalTokens: 999, totalCost: 100 }],
        },
        filters: { ...base.filters, ...scope, timeZone: "utc", selectedDays: [selectedDay.date] },
        callbacks: {
          ...base.callbacks,
          display: { ...base.callbacks.display, onExportJson },
        },
      }),
    ),
    container,
  );
  expect(
    [...container.querySelectorAll(".usage-metric-badge strong")].map((el) => el.textContent),
  ).toEqual(["99", "$10.00", "1"]);
  container.querySelector(".usage-export-menu")!.dispatchEvent(
    new CustomEvent("wa-select", {
      detail: { item: { value: "json" } },
    }),
  );
  const { date, tokens: _tokens, cost: _cost, ...expectedTotals } = selectedDay;
  expect(onExportJson.mock.calls[0]?.[0].totals).toEqual(expectedTotals);
  expect(
    onExportJson.mock.calls[0]?.[0].daily.find(
      (day: { date: string }) => day.date === "2026-05-13",
    ),
  ).toMatchObject({ totalCost: scope.selectedSessions?.length === 1 ? 70 : 75 });
  expect(onExportJson.mock.calls[0]?.[0].daily).toEqual(
    expect.arrayContaining([{ date, ...expectedTotals }]),
  );
});

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

  it("keeps bounded filter inventories in source order across observed and aggregate values", () => {
    const sessions = ["observed-a", "observed-b", "observed-a"].map((provider, index) =>
      Object.assign(usageSession(`session-${index}`, "main", provider), {
        providerOverride: `override-${index}`,
        modelOverride: "override-only-model",
        channel: index === 0 ? "" : "Chat",
      }),
    );
    const aggregates = buildAggregatesFromSessions(
      Array.from({ length: 14 }, (_, index) =>
        usageSession(`aggregate-${index}`, "other", `aggregate-${index}`),
      ),
    );
    aggregates.tools.tools = Array.from({ length: 14 }, (_, index) => ({
      name: `tool-${index}`,
      count: 1,
    }));
    const options = buildUsageFilterOptions(sessions, aggregates);
    expect(options.channel).toEqual(["Chat"]);
    expect(options.provider).toEqual([
      "observed-a",
      "observed-b",
      "override-0",
      "override-1",
      "override-2",
      ...Array.from({ length: 7 }, (_, index) => `aggregate-${index}`),
    ]);
    expect(options.model).toEqual([
      "observed-a-model",
      "observed-b-model",
      ...Array.from({ length: 10 }, (_, index) => `aggregate-${index}-model`),
    ]);
    expect(options.tool).toEqual(Array.from({ length: 12 }, (_, index) => `tool-${index}`));
  });

  it("refreshes filter order and draft selections when chart mode, agent, or source changes", () => {
    const container = document.createElement("div");
    const props = createUsageProps();
    props.data.sessions = [
      usageSession("first", "main", "first", { totalTokens: 200, totalCost: 1 }),
      usageSession("second", "other", "second", { totalTokens: 100, totalCost: 2 }),
    ];
    props.filters.query = "provider:absent";
    props.filters.queryDraft = 'label:"Team  Planning" provider:second';
    props.callbacks.filters.onQueryDraftChange = vi.fn();
    const providerOptions = () =>
      [...container.querySelectorAll<HTMLElement>(".usage-filter-select")]
        .find(
          (menu) => menu.querySelector(".usage-filter-trigger span")?.textContent === "Provider",
        )!
        .querySelectorAll<HTMLElement & { checked: boolean }>(".usage-filter-option");
    const values = () => [...providerOptions()].map((option) => option.textContent?.trim());

    render(renderUsage(props), container);
    expect(values()).toEqual(["first", "second"]);
    expect([...providerOptions()].find((option) => option.checked)?.textContent?.trim()).toBe(
      "second",
    );
    expect(container.querySelector(".usage-query-suggestion")?.textContent?.trim()).toBe(
      "provider:second",
    );

    props.display.chartMode = "cost";
    render(renderUsage(props), container);
    expect(values()).toEqual(["second", "first"]);
    props.filters.agentId = "main";
    render(renderUsage(props), container);
    expect(values()).toEqual(["first"]);
    expect(container.querySelector(".usage-query-suggestion")).toBeNull();

    props.data.sessions = [usageSession("replacement", "main", "second-new")];
    render(renderUsage(props), container);
    expect(values()).toEqual(["second-new"]);
    container.querySelector<HTMLButtonElement>(".usage-query-suggestion")?.click();
    expect(props.callbacks.filters.onQueryDraftChange).toHaveBeenCalledWith(
      'label:"Team  Planning" provider:second-new ',
    );
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
                  { type: "budget", used: 12.5, limit: 20, unit: " jPy " },
                  { type: "budget", used: 1.5, limit: 3, unit: " Credits " },
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
    expect(
      Array.from(
        container.querySelectorAll(".provider-usage-billing-row strong"),
        (value) => value.textContent,
      ),
    ).toEqual(["$64.50", "$5.00 / $20.00", "¥13 / ¥20", "1.5  Credits  / 3  Credits "]);
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
