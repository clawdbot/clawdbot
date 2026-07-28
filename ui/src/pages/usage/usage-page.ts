import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CostUsageSummary,
  SessionsUsageResult,
  SessionUsageTimeSeries,
} from "../../api/types.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  type PanelRefreshStatus,
} from "../../components/panel-refresh-status.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import {
  buildSessionUsageDateParams,
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
} from "../../lib/sessions/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { mergeUsageCacheStatus } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { failUsageDetailRefresh } from "./detail-refresh.ts";
import {
  currentLocalDate,
  selectUsageSessionKeys,
  toggleUsageRangeSelection,
  toUsageErrorMessage,
} from "./helpers.ts";
import { renderUsagePageShell } from "./page-shell.ts";
import {
  DEFAULT_VISIBLE_COLUMNS,
  type SessionLogEntry,
  type SessionLogRole,
  type UsageProps,
} from "./types.ts";
import { UsageRefreshRuntime } from "./usage-refresh-runtime.ts";
import { renderUsage } from "./view.ts";

export type UsageRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  query: {
    startDate: string;
    endDate: string;
    scope: "instance" | "family";
    timeZone: "local" | "utc";
    agentId: string | null;
  };
  result: SessionsUsageResult | null;
  costSummary: CostUsageSummary | null;
  providerUsageSummary: ProviderUsageSummary | null;
  loadedAtMs: number | null;
  error: string | null;
};

type UsageTaskValue = {
  result: SessionsUsageResult;
  costSummary: CostUsageSummary;
  providerUsageSummary: ProviderUsageSummary | null;
};

type UsageDetailTaskValue<T> = {
  sessionKey: string;
  data: T;
};

class UsagePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: UsageRouteData;

  @state() private usageResult: SessionsUsageResult | null = null;
  @state() private usageCostSummary: CostUsageSummary | null = null;
  @state() private providerUsageSummary: ProviderUsageSummary | null = null;
  @state() private usageError: string | null = null;
  @state() private usageStartDate = currentLocalDate();
  @state() private usageEndDate = currentLocalDate();
  @state() private usageLoadStartDate = this.usageStartDate;
  @state() private usageLoadEndDate = this.usageEndDate;
  @state() private usageScope: "instance" | "family" = "family";
  @state() private usageAgentId: string | null = null;
  @state() private usageSelectedSessions: string[] = [];
  @state() private usageSelectedDays: string[] = [];
  @state() private usageSelectedHours: number[] = [];
  @state() private usageChartMode: "tokens" | "cost" = "tokens";
  @state() private usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() private usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  private usageTimeSeriesValue: UsageDetailTaskValue<SessionUsageTimeSeries | null> | null = null;
  @state() private usageTimeSeriesStatus = createPanelRefreshStatus();
  @state() private usageTimeSeriesCursorStart: number | null = null;
  @state() private usageTimeSeriesCursorEnd: number | null = null;
  private usageSessionLogsValue: UsageDetailTaskValue<SessionLogEntry[] | null> | null = null;
  @state() private usageSessionLogsStatus = createPanelRefreshStatus();
  @state() private usageSessionLogsExpanded = false;
  @state() private usageQuery = "";
  @state() private usageQueryDraft = "";
  @state() private usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" =
    "recent";
  @state() private usageSessionSortDir: "desc" | "asc" = "desc";
  @state() private usageRecentSessions: string[] = [];
  @state() private usageTimeZone: "local" | "utc" = "local";
  @state() private usageContextExpanded = false;
  @state() private usageHeaderPinned = false;
  @state() private usageSessionsTab: "all" | "recent" = "all";
  @state() private usageVisibleColumns = [...DEFAULT_VISIBLE_COLUMNS];
  @state() private usageLogFilterRoles: SessionLogRole[] = [];
  @state() private usageLogFilterTools: string[] = [];
  @state() private usageLogFilterHasTools = false;
  @state() private usageLogFilterQuery = "";

  private dateDebounceTimer: number | null = null;
  private queryDebounceTimer: number | null = null;
  // Invalidation runs the Task with a null client to supersede stale completions.
  // Track real gateway work separately so that no-op runs cannot block reconnect retries.
  private usageTaskActiveClient: GatewayBrowserClient | null = null;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private observedAgentScopeId: string | null | undefined;
  private readonly refreshRuntime = new UsageRefreshRuntime(this, {
    getGateway: () => this.context?.gateway,
    isLoading: () => this.usageLoading,
    isRouteDataInitialized: () => this.routeDataInitialized,
    ensureAgents: () => void this.context.agents.ensureList(),
    invalidateRequests: () => {
      this.usageTaskActiveClient = null;
      void this.usageTask.run(this.usageTaskArgs(null));
      void this.usageTimeSeriesTask.run([null, ""]);
      void this.usageSessionLogsTask.run([null, ""]);
    },
    resetForClientChange: () => this.resetForClientChange(),
    reload: () => this.performUsageReload(),
  });

  private usageTaskArgs(
    client = this.refreshRuntime.connected ? this.refreshRuntime.client : null,
  ) {
    return [
      client,
      this.usageLoadStartDate,
      this.usageLoadEndDate,
      this.usageScope,
      this.usageTimeZone,
      normalizeLowercaseStringOrEmpty(this.usageAgentId ?? "") || null,
    ] as const;
  }

  private readonly usageTask = new Task(this, {
    autoRun: false,
    args: () => this.usageTaskArgs(),
    task: async ([client, startDate, endDate, scope, timeZone, normalizedAgentId], { signal }) => {
      if (!client) {
        return initialState;
      }
      if (this.routeDataEnabled) {
        return initialState;
      }
      this.refreshRuntime.beginLoad();
      const agentId = normalizedAgentId || undefined;
      const agentScopeParams = agentId ? { agentId } : { agentScope: "all" as const };
      const [result, costSummary, providerUsageSummary] = await Promise.all([
        requestSessionUsage(client, { startDate, endDate, agentId, scope, timeZone }),
        client.request<CostUsageSummary>(
          "usage.cost",
          {
            startDate,
            endDate,
            ...agentScopeParams,
            ...buildSessionUsageDateParams(timeZone),
          },
          { signal },
        ),
        client
          .request<ProviderUsageSummary>("usage.status", undefined, { signal })
          .catch(() => null),
      ]);
      return { result, costSummary, providerUsageSummary } satisfies UsageTaskValue;
    },
    onComplete: (value) => {
      this.usageTaskActiveClient = null;
      this.usageResult = value.result;
      this.usageCostSummary = value.costSummary;
      this.providerUsageSummary = value.providerUsageSummary;
      this.usageError = null;
      this.refreshRuntime.markLoaded();
      this.refreshRuntime.flushPending();
    },
    onError: (error) => {
      this.usageTaskActiveClient = null;
      if (isMissingOperatorReadScopeError(error)) {
        this.usageResult = null;
        this.usageCostSummary = null;
        this.usageError = formatMissingOperatorReadScopeMessage("usage");
      } else {
        this.usageError = toUsageErrorMessage(error);
      }
      this.refreshRuntime.flushPending();
    },
  });

  private createUsageDetailTask<T>(
    load: (client: GatewayBrowserClient, sessionKey: string) => Promise<T>,
    status: () => PanelRefreshStatus,
    apply: (value: UsageDetailTaskValue<T> | null | undefined, status: PanelRefreshStatus) => void,
  ) {
    return new Task(this, {
      autoRun: false,
      args: () =>
        [
          this.refreshRuntime.connected ? this.refreshRuntime.client : null,
          this.usageSelectedSessions.length === 1 ? (this.usageSelectedSessions[0] ?? "") : "",
        ] as const,
      task: async ([client, sessionKey]) =>
        client && sessionKey ? { sessionKey, data: await load(client, sessionKey) } : initialState,
      onComplete: (value) => apply(value, completePanelRefresh()),
      onError: (error) => {
        const failure = failUsageDetailRefresh(status(), error);
        apply(failure.clearData ? null : undefined, failure.status);
      },
    });
  }

  private readonly usageTimeSeriesTask = this.createUsageDetailTask(
    requestSessionUsageTimeSeries,
    () => this.usageTimeSeriesStatus,
    (value, status) => {
      if (value !== undefined) {
        this.usageTimeSeriesValue = value;
      }
      this.usageTimeSeriesStatus = status;
    },
  );

  private readonly usageSessionLogsTask = this.createUsageDetailTask(
    async (client, sessionKey) => {
      const payload = await requestSessionUsageLogs(client, sessionKey);
      return Array.isArray(payload.logs) ? (payload.logs as SessionLogEntry[]) : null;
    },
    () => this.usageSessionLogsStatus,
    (value, status) => {
      if (value !== undefined) {
        this.usageSessionLogsValue = value;
      }
      this.usageSessionLogsStatus = status;
    },
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agentSelection,
      (selection) => {
        const sync = () => {
          const nextScopeId = selection.state.scopeId;
          const changed = this.observedAgentScopeId !== nextScopeId;
          this.observedAgentScopeId = nextScopeId;
          if (changed && this.routeDataInitialized && this.usageAgentId !== nextScopeId) {
            this.usageAgentId = nextScopeId;
            this.clearSelectionsAndDetails();
            this.refreshRuntime.reload();
          }
          this.requestUpdate();
        };
        sync();
        return selection.subscribe(sync);
      },
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.applyRouteData();
      this.ensureInitialData();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.refreshRuntime.connect();
  }

  override disconnectedCallback() {
    this.refreshRuntime.disconnect();
    this.subscriptions.clear();
    this.clearDateDebounce();
    this.clearQueryDebounce();
    this.usageTaskActiveClient = null;
    void this.usageTask.run(this.usageTaskArgs(null));
    void this.usageTimeSeriesTask.run([null, ""]);
    void this.usageSessionLogsTask.run([null, ""]);
    super.disconnectedCallback();
  }

  private applyRouteData() {
    const data = this.routeData;
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    if (!this.routeDataEnabled) {
      return;
    }
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    this.refreshRuntime.adoptGatewaySnapshot(snapshot);
    if (data.gateway !== gateway || data.gatewaySnapshot !== snapshot) {
      this.routeDataEnabled = false;
      return;
    }
    const currentAgentId = this.context.agentSelection.state.scopeId;
    if (data.query.agentId !== currentAgentId) {
      this.usageAgentId = currentAgentId;
      this.clearSelectionsAndDetails();
      this.refreshRuntime.reload();
      return;
    }

    this.usageStartDate = data.query.startDate;
    this.usageEndDate = data.query.endDate;
    this.usageLoadStartDate = data.query.startDate;
    this.usageLoadEndDate = data.query.endDate;
    this.usageScope = data.query.scope;
    this.usageTimeZone = data.query.timeZone;
    this.usageAgentId = data.query.agentId;
    this.usageResult = data.result;
    this.usageCostSummary = data.costSummary;
    this.providerUsageSummary = data.providerUsageSummary;
    this.refreshRuntime.setLastLoadedAtMs(data.loadedAtMs);
    this.usageError = data.error;
  }

  private ensureInitialData() {
    if (
      this.routeDataEnabled ||
      !this.routeDataInitialized ||
      !this.refreshRuntime.client ||
      !this.refreshRuntime.connected ||
      this.usageLoading
    ) {
      return;
    }
    void this.loadUsage();
  }

  private resetForClientChange() {
    this.clearDateDebounce();
    this.usageTaskActiveClient = null;
    void this.usageTask.run(this.usageTaskArgs(null));
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.usageResult = null;
    this.usageCostSummary = null;
    this.providerUsageSummary = null;
    this.refreshRuntime.resetPayload();
    this.usageError = null;
    this.usageAgentId = this.context.agentSelection.state.scopeId;
    this.clearSelectionsAndDetails();
  }

  private get usageLoading(): boolean {
    return !this.routeDataInitialized || this.usageTaskActiveClient !== null;
  }

  private get usageTimeSeries() {
    return this.usageTimeSeriesValue?.data ?? null;
  }

  private get usageSessionLogs() {
    return this.usageSessionLogsValue?.data ?? null;
  }

  private loadUsage(): Promise<void> {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      this.refreshRuntime.markLoadDeferred();
      return Promise.resolve();
    }
    if (this.usageLoading) {
      return Promise.resolve();
    }
    this.routeDataEnabled = false;
    this.usageLoadStartDate = this.usageStartDate;
    this.usageLoadEndDate = this.usageEndDate;
    this.usageError = null;
    this.usageTaskActiveClient = client;
    return this.usageTask.run();
  }

  private loadSessionTimeSeries(sessionKey: string): Promise<void> {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      return Promise.resolve();
    }
    if (this.usageTimeSeriesValue?.sessionKey !== sessionKey) {
      this.usageTimeSeriesValue = null;
      this.usageTimeSeriesStatus = createPanelRefreshStatus();
    }
    this.usageTimeSeriesStatus = beginPanelRefresh(this.usageTimeSeriesStatus);
    return this.usageTimeSeriesTask.run([client, sessionKey]);
  }

  private loadSessionLogs(sessionKey: string): Promise<void> {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      return Promise.resolve();
    }
    if (this.usageSessionLogsValue?.sessionKey !== sessionKey) {
      this.usageSessionLogsValue = null;
      this.usageSessionLogsStatus = createPanelRefreshStatus();
    }
    this.usageSessionLogsStatus = beginPanelRefresh(this.usageSessionLogsStatus);
    return this.usageSessionLogsTask.run([client, sessionKey]);
  }

  private clearSelections() {
    this.usageSelectedDays = [];
    this.usageSelectedHours = [];
    this.usageSelectedSessions = [];
  }

  private clearDetails() {
    this.usageTimeSeriesValue = null;
    this.usageSessionLogsValue = null;
    this.usageTimeSeriesStatus = createPanelRefreshStatus();
    this.usageSessionLogsStatus = createPanelRefreshStatus();
    void this.usageTimeSeriesTask.run([null, ""]);
    void this.usageSessionLogsTask.run([null, ""]);
    this.usageTimeSeriesCursorStart = null;
    this.usageTimeSeriesCursorEnd = null;
  }

  private clearSelectionsAndDetails() {
    this.clearSelections();
    this.clearDetails();
  }

  private clearDateDebounce() {
    if (this.dateDebounceTimer !== null) {
      window.clearTimeout(this.dateDebounceTimer);
      this.dateDebounceTimer = null;
    }
  }

  private scheduleUsageLoad() {
    this.clearDateDebounce();
    this.routeDataEnabled = false;
    this.dateDebounceTimer = window.setTimeout(() => {
      this.dateDebounceTimer = null;
      void this.loadUsage();
    }, 400);
  }

  private performUsageReload() {
    this.clearDateDebounce();
    void this.loadUsage();
  }

  private clearQueryDebounce() {
    if (this.queryDebounceTimer !== null) {
      window.clearTimeout(this.queryDebounceTimer);
      this.queryDebounceTimer = null;
    }
  }

  private selectSession(key: string, shiftKey: boolean) {
    this.clearDetails();
    this.usageRecentSessions = [
      key,
      ...this.usageRecentSessions.filter((entry) => entry !== key),
    ].slice(0, 8);

    this.usageSelectedSessions = selectUsageSessionKeys(
      this.usageSelectedSessions,
      key,
      this.usageResult?.sessions ?? [],
      this.usageChartMode === "tokens",
      shiftKey,
    );

    if (this.usageSelectedSessions.length === 1) {
      const sessionKey = this.usageSelectedSessions[0];
      if (sessionKey) {
        void this.loadSessionTimeSeries(sessionKey);
        void this.loadSessionLogs(sessionKey);
      }
    }
  }

  override render() {
    const props: UsageProps = {
      data: {
        loading: this.usageLoading,
        error: this.usageError,
        sessions: this.usageResult?.sessions ?? [],
        agents:
          this.context.agents.state.agentsList?.agents.map((entry) => entry.id).filter(Boolean) ??
          [],
        sessionsLimitReached: (this.usageResult?.sessions.length ?? 0) >= 1000,
        totals: this.usageResult?.totals ?? null,
        aggregates: this.usageResult?.aggregates ?? null,
        costDaily: this.usageCostSummary?.daily ?? [],
        cacheStatus: mergeUsageCacheStatus(
          this.usageResult?.cacheStatus,
          this.usageCostSummary?.cacheStatus,
        ),
        providerUsage: this.providerUsageSummary?.providers ?? [],
      },
      filters: {
        startDate: this.usageStartDate,
        endDate: this.usageEndDate,
        scope: this.usageScope,
        selectedSessions: this.usageSelectedSessions,
        selectedDays: this.usageSelectedDays,
        selectedHours: this.usageSelectedHours,
        agentId: this.usageAgentId,
        query: this.usageQuery,
        queryDraft: this.usageQueryDraft,
        timeZone: this.usageTimeZone,
      },
      display: {
        chartMode: this.usageChartMode,
        dailyChartMode: this.usageDailyChartMode,
        sessionSort: this.usageSessionSort,
        sessionSortDir: this.usageSessionSortDir,
        recentSessions: this.usageRecentSessions,
        sessionsTab: this.usageSessionsTab,
        visibleColumns: this.usageVisibleColumns,
        contextExpanded: this.usageContextExpanded,
        headerPinned: this.usageHeaderPinned,
      },
      detail: {
        timeSeriesMode: this.usageTimeSeriesMode,
        timeSeriesBreakdownMode: this.usageTimeSeriesBreakdownMode,
        timeSeries: this.usageTimeSeries,
        timeSeriesLoading: this.usageTimeSeriesTask.status === TaskStatus.PENDING,
        timeSeriesStatus: this.usageTimeSeriesStatus,
        timeSeriesCursorStart: this.usageTimeSeriesCursorStart,
        timeSeriesCursorEnd: this.usageTimeSeriesCursorEnd,
        sessionLogs: this.usageSessionLogs,
        sessionLogsLoading: this.usageSessionLogsTask.status === TaskStatus.PENDING,
        sessionLogsStatus: this.usageSessionLogsStatus,
        sessionLogsExpanded: this.usageSessionLogsExpanded,
        logFilters: {
          roles: this.usageLogFilterRoles,
          tools: this.usageLogFilterTools,
          hasTools: this.usageLogFilterHasTools,
          query: this.usageLogFilterQuery,
        },
      },
      callbacks: {
        filters: {
          onStartDateChange: (date) => {
            this.usageStartDate = date;
            this.clearSelectionsAndDetails();
            this.scheduleUsageLoad();
          },
          onEndDateChange: (date) => {
            this.usageEndDate = date;
            this.clearSelectionsAndDetails();
            this.scheduleUsageLoad();
          },
          onScopeChange: (scope) => {
            this.usageScope = scope;
            this.clearSelectionsAndDetails();
            this.refreshRuntime.reload();
          },
          onAgentChange: (agentId) => {
            this.context.agentSelection.setScope(agentId);
          },
          onRefresh: () => this.refreshRuntime.request("manual"),
          onTimeZoneChange: (timeZone) => {
            this.usageTimeZone = timeZone;
            this.clearSelectionsAndDetails();
            this.refreshRuntime.reload();
          },
          onToggleHeaderPinned: () => {
            this.usageHeaderPinned = !this.usageHeaderPinned;
          },
          onSelectHour: (hour, shiftKey) => {
            this.usageSelectedHours = toggleUsageRangeSelection(
              this.usageSelectedHours,
              hour,
              Array.from({ length: 24 }, (_, index) => index),
              shiftKey,
              true,
            );
          },
          onQueryDraftChange: (query) => {
            this.usageQueryDraft = query;
            this.clearQueryDebounce();
            this.queryDebounceTimer = window.setTimeout(() => {
              this.usageQuery = this.usageQueryDraft;
              this.queryDebounceTimer = null;
            }, 250);
          },
          onApplyQuery: () => {
            this.clearQueryDebounce();
            this.usageQuery = this.usageQueryDraft;
          },
          onClearQuery: () => {
            this.clearQueryDebounce();
            this.usageQueryDraft = "";
            this.usageQuery = "";
          },
          onSelectDay: (day, shiftKey) => {
            this.usageSelectedDays = toggleUsageRangeSelection(
              this.usageSelectedDays,
              day,
              (this.usageCostSummary?.daily ?? []).map((entry) => entry.date),
              shiftKey,
              false,
            );
          },
          onClearDays: () => {
            this.usageSelectedDays = [];
          },
          onClearHours: () => {
            this.usageSelectedHours = [];
          },
          onClearSessions: () => {
            this.usageSelectedSessions = [];
            this.clearDetails();
          },
          onClearFilters: () => this.clearSelectionsAndDetails(),
        },
        display: {
          onChartModeChange: (mode) => {
            this.usageChartMode = mode;
          },
          onDailyChartModeChange: (mode) => {
            this.usageDailyChartMode = mode;
          },
          onSessionSortChange: (sort) => {
            this.usageSessionSort = sort;
          },
          onSessionSortDirChange: (direction) => {
            this.usageSessionSortDir = direction;
          },
          onSessionsTabChange: (tab) => {
            this.usageSessionsTab = tab;
          },
          onToggleColumn: (column) => {
            this.usageVisibleColumns = this.usageVisibleColumns.includes(column)
              ? this.usageVisibleColumns.filter((entry) => entry !== column)
              : [...this.usageVisibleColumns, column];
          },
        },
        details: {
          onToggleContextExpanded: () => {
            this.usageContextExpanded = !this.usageContextExpanded;
          },
          onToggleSessionLogsExpanded: () => {
            this.usageSessionLogsExpanded = !this.usageSessionLogsExpanded;
          },
          onLogFilterRolesChange: (roles) => {
            this.usageLogFilterRoles = roles;
          },
          onLogFilterToolsChange: (tools) => {
            this.usageLogFilterTools = tools;
          },
          onLogFilterHasToolsChange: (hasTools) => {
            this.usageLogFilterHasTools = hasTools;
          },
          onLogFilterQueryChange: (query) => {
            this.usageLogFilterQuery = query;
          },
          onLogFilterClear: () => {
            this.usageLogFilterRoles = [];
            this.usageLogFilterTools = [];
            this.usageLogFilterHasTools = false;
            this.usageLogFilterQuery = "";
          },
          onSelectSession: (key, shiftKey) => this.selectSession(key, shiftKey),
          onTimeSeriesModeChange: (mode) => {
            this.usageTimeSeriesMode = mode;
          },
          onTimeSeriesBreakdownChange: (mode) => {
            this.usageTimeSeriesBreakdownMode = mode;
          },
          onTimeSeriesCursorRangeChange: (start, end) => {
            this.usageTimeSeriesCursorStart = start;
            this.usageTimeSeriesCursorEnd = end;
          },
          onRetryTimeSeries: () => {
            const sessionKey = this.usageSelectedSessions[0];
            if (sessionKey) {
              void this.loadSessionTimeSeries(sessionKey);
            }
          },
          onRetrySessionLogs: () => {
            const sessionKey = this.usageSelectedSessions[0];
            if (sessionKey) {
              void this.loadSessionLogs(sessionKey);
            }
          },
        },
      },
    };

    return renderUsagePageShell(this.context, this.usageResult, renderUsage(props));
  }
}

if (!customElements.get("openclaw-usage-page")) {
  customElements.define("openclaw-usage-page", UsagePage);
}
