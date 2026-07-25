import { consume } from "@lit/context";
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

class UsagePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: UsageRouteData;

  @state() private usageLoading = true;
  @state() private usageResult: SessionsUsageResult | null = null;
  @state() private usageCostSummary: CostUsageSummary | null = null;
  @state() private providerUsageSummary: ProviderUsageSummary | null = null;
  @state() private usageError: string | null = null;
  @state() private usageStartDate = currentLocalDate();
  @state() private usageEndDate = currentLocalDate();
  @state() private usageScope: "instance" | "family" = "family";
  @state() private usageAgentId: string | null = null;
  @state() private usageSelectedSessions: string[] = [];
  @state() private usageSelectedDays: string[] = [];
  @state() private usageSelectedHours: number[] = [];
  @state() private usageChartMode: "tokens" | "cost" = "tokens";
  @state() private usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() private usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() private usageTimeSeries: SessionUsageTimeSeries | null = null;
  private usageTimeSeriesSessionKey: string | null = null;
  @state() private usageTimeSeriesLoading = false;
  @state() private usageTimeSeriesStatus = createPanelRefreshStatus();
  @state() private usageTimeSeriesCursorStart: number | null = null;
  @state() private usageTimeSeriesCursorEnd: number | null = null;
  @state() private usageSessionLogs: SessionLogEntry[] | null = null;
  private usageSessionLogsSessionKey: string | null = null;
  @state() private usageSessionLogsLoading = false;
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

  private usageRequestId = 0;
  private timeSeriesRequestId = 0;
  private logsRequestId = 0;
  private dateDebounceTimer: number | null = null;
  private queryDebounceTimer: number | null = null;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private observedAgentScopeId: string | null | undefined;
  private readonly refreshRuntime = new UsageRefreshRuntime(this, {
    getGateway: () => this.context?.gateway,
    isLoading: () => this.usageLoading,
    isRouteDataInitialized: () => this.routeDataInitialized,
    ensureAgents: () => void this.context.agents.ensureList(),
    invalidateRequests: () => this.invalidateRequests(),
    resetForClientChange: () => this.resetForClientChange(),
    reload: () => this.performUsageReload(),
  });
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
    this.invalidateRequests();
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
      this.usageLoading = false;
      return;
    }
    const currentAgentId = this.context.agentSelection.state.scopeId;
    if (data.query.agentId !== currentAgentId) {
      // Route loaders may finish after the page scope changes. Ignore their
      // stale result and restart from the current scope in one operation.
      this.usageAgentId = currentAgentId;
      this.clearSelectionsAndDetails();
      this.refreshRuntime.reload();
      return;
    }

    this.usageStartDate = data.query.startDate;
    this.usageEndDate = data.query.endDate;
    this.usageScope = data.query.scope;
    this.usageTimeZone = data.query.timeZone;
    this.usageAgentId = data.query.agentId;
    this.usageResult = data.result;
    this.usageCostSummary = data.costSummary;
    this.providerUsageSummary = data.providerUsageSummary;
    this.refreshRuntime.setLastLoadedAtMs(data.loadedAtMs);
    this.usageError = data.error;
    this.usageLoading = false;
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
    this.invalidateRequests();
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

  private invalidateRequests() {
    this.usageRequestId += 1;
    this.timeSeriesRequestId += 1;
    this.logsRequestId += 1;
    this.usageLoading = false;
    this.usageTimeSeriesLoading = false;
    this.usageSessionLogsLoading = false;
  }

  private invalidateUsageRequest() {
    this.usageRequestId += 1;
    this.routeDataEnabled = false;
    this.usageLoading = false;
  }

  private invalidateDetailRequests() {
    this.timeSeriesRequestId += 1;
    this.logsRequestId += 1;
    this.usageTimeSeriesLoading = false;
    this.usageSessionLogsLoading = false;
  }

  private isCurrentRequest(requestId: number, client: GatewayBrowserClient): boolean {
    const gateway = this.context.gateway.snapshot;
    return this.isConnected && requestId === this.usageRequestId && gateway.client === client;
  }

  private isCurrentDetailRequest(
    requestId: number,
    currentRequestId: number,
    client: GatewayBrowserClient,
    sessionKey: string,
  ): boolean {
    const gateway = this.context.gateway.snapshot;
    return (
      this.isConnected &&
      requestId === currentRequestId &&
      gateway.client === client &&
      this.usageSelectedSessions.length === 1 &&
      this.usageSelectedSessions[0] === sessionKey
    );
  }

  private async loadUsage() {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      this.refreshRuntime.markLoadDeferred();
      return;
    }
    if (this.usageLoading) {
      return;
    }

    this.refreshRuntime.beginLoad();
    this.routeDataEnabled = false;
    const requestId = ++this.usageRequestId;
    const startDate = this.usageStartDate;
    const endDate = this.usageEndDate;
    const scope = this.usageScope;
    const timeZone = this.usageTimeZone;
    const agentId = normalizeLowercaseStringOrEmpty(this.usageAgentId ?? "") || undefined;
    this.usageLoading = true;
    this.usageError = null;
    try {
      const agentScopeParams = agentId ? { agentId } : { agentScope: "all" as const };
      const [sessionsResult, costSummary, providerUsageSummary] = await Promise.all([
        requestSessionUsage(client, { startDate, endDate, agentId, scope, timeZone }),
        client.request<CostUsageSummary>("usage.cost", {
          startDate,
          endDate,
          ...agentScopeParams,
          ...buildSessionUsageDateParams(timeZone),
        }),
        client.request<ProviderUsageSummary>("usage.status").catch(() => null),
      ]);
      if (!this.isCurrentRequest(requestId, client)) {
        return;
      }
      this.usageResult = sessionsResult;
      this.usageCostSummary = costSummary;
      this.providerUsageSummary = providerUsageSummary;
      this.refreshRuntime.markLoaded();
    } catch (error) {
      if (!this.isCurrentRequest(requestId, client)) {
        return;
      }
      if (isMissingOperatorReadScopeError(error)) {
        this.usageResult = null;
        this.usageCostSummary = null;
        this.usageError = formatMissingOperatorReadScopeMessage("usage");
      } else {
        this.usageError = toUsageErrorMessage(error);
      }
    } finally {
      if (this.isCurrentRequest(requestId, client)) {
        this.usageLoading = false;
        this.refreshRuntime.flushPending();
      }
    }
  }

  private async loadSessionTimeSeries(sessionKey: string) {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      return;
    }
    // Never render another session's retained timeline as stale.
    if (this.usageTimeSeriesSessionKey !== sessionKey) {
      this.usageTimeSeries = null;
      this.usageTimeSeriesSessionKey = null;
      this.usageTimeSeriesStatus = createPanelRefreshStatus();
    }
    const requestId = ++this.timeSeriesRequestId;
    this.usageTimeSeriesLoading = true;
    this.usageTimeSeriesStatus = beginPanelRefresh(this.usageTimeSeriesStatus);
    try {
      const result = await requestSessionUsageTimeSeries(client, sessionKey);
      if (this.isCurrentDetailRequest(requestId, this.timeSeriesRequestId, client, sessionKey)) {
        this.usageTimeSeries = result;
        this.usageTimeSeriesSessionKey = sessionKey;
        this.usageTimeSeriesStatus = completePanelRefresh();
      }
    } catch (error) {
      if (this.isCurrentDetailRequest(requestId, this.timeSeriesRequestId, client, sessionKey)) {
        const failure = failUsageDetailRefresh(this.usageTimeSeriesStatus, error);
        this.usageTimeSeriesStatus = failure.status;
        if (failure.clearData) {
          this.usageTimeSeries = null;
          this.usageTimeSeriesSessionKey = null;
        }
      }
    } finally {
      if (this.isCurrentDetailRequest(requestId, this.timeSeriesRequestId, client, sessionKey)) {
        this.usageTimeSeriesLoading = false;
      }
    }
  }

  private async loadSessionLogs(sessionKey: string) {
    const client = this.refreshRuntime.client;
    if (!client || !this.refreshRuntime.connected) {
      return;
    }
    // Never render another session's retained conversation as stale.
    if (this.usageSessionLogsSessionKey !== sessionKey) {
      this.usageSessionLogs = null;
      this.usageSessionLogsSessionKey = null;
      this.usageSessionLogsStatus = createPanelRefreshStatus();
    }
    const requestId = ++this.logsRequestId;
    this.usageSessionLogsLoading = true;
    this.usageSessionLogsStatus = beginPanelRefresh(this.usageSessionLogsStatus);
    try {
      const payload = await requestSessionUsageLogs(client, sessionKey);
      if (!this.isCurrentDetailRequest(requestId, this.logsRequestId, client, sessionKey)) {
        return;
      }
      this.usageSessionLogs = Array.isArray(payload.logs)
        ? (payload.logs as SessionLogEntry[])
        : null;
      this.usageSessionLogsSessionKey = sessionKey;
      this.usageSessionLogsStatus = completePanelRefresh();
    } catch (error) {
      if (this.isCurrentDetailRequest(requestId, this.logsRequestId, client, sessionKey)) {
        const failure = failUsageDetailRefresh(this.usageSessionLogsStatus, error);
        this.usageSessionLogsStatus = failure.status;
        if (failure.clearData) {
          this.usageSessionLogs = null;
          this.usageSessionLogsSessionKey = null;
        }
      }
    } finally {
      if (this.isCurrentDetailRequest(requestId, this.logsRequestId, client, sessionKey)) {
        this.usageSessionLogsLoading = false;
      }
    }
  }

  private clearSelections() {
    this.usageSelectedDays = [];
    this.usageSelectedHours = [];
    this.usageSelectedSessions = [];
  }

  private clearDetails() {
    this.invalidateDetailRequests();
    this.usageTimeSeries = null;
    this.usageTimeSeriesSessionKey = null;
    this.usageTimeSeriesStatus = createPanelRefreshStatus();
    this.usageSessionLogs = null;
    this.usageSessionLogsSessionKey = null;
    this.usageSessionLogsStatus = createPanelRefreshStatus();
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
    this.invalidateUsageRequest();
    this.dateDebounceTimer = window.setTimeout(() => {
      this.dateDebounceTimer = null;
      void this.loadUsage();
    }, 400);
  }

  private performUsageReload() {
    this.clearDateDebounce();
    this.invalidateUsageRequest();
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
        timeSeriesLoading: this.usageTimeSeriesLoading,
        timeSeriesStatus: this.usageTimeSeriesStatus,
        timeSeriesCursorStart: this.usageTimeSeriesCursorStart,
        timeSeriesCursorEnd: this.usageTimeSeriesCursorEnd,
        sessionLogs: this.usageSessionLogs,
        sessionLogsLoading: this.usageSessionLogsLoading,
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
