import { consume } from "@lit/context";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { isUsageIncomplete } from "../../lib/incomplete-usage-retry.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { isUsageCacheIncomplete } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { UsageDetailsController } from "./detail-controller.ts";
import { createUsageJsonExportRequest } from "./export.ts";
import {
  currentLocalDate,
  selectUsageSessionKeys,
  toggleUsageRangeSelection,
  toUsageErrorMessage,
} from "./helpers.ts";
import { renderUsagePageShell } from "./page-shell.ts";
import { UsageRefreshPolicy } from "./refresh-policy.ts";
import {
  providerUsageFromSnapshotResult,
  type ProviderUsageSnapshot,
  requestUsageSnapshot,
} from "./request-usage-snapshot.ts";
import { createUsageRequest } from "./request.ts";
import {
  DEFAULT_VISIBLE_COLUMNS,
  type SessionLogRole,
  type UsageProps,
  type UsageRouteData,
} from "./types.ts";
import { renderUsage } from "./view.ts";

export type { UsageRouteData } from "./types.ts";

class UsagePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData?: UsageRouteData;

  @state() private usageResult: SessionsUsageResult | null = null;
  @state() private usageCostSummary: CostUsageSummary | null = null;
  @state() private providerUsageSummary: ProviderUsageSummary | null = null;
  @state() private providerUsageUnavailable = false;
  @state() private providerUsageIncomplete = false;
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
  @state() private usageTimeSeriesCursorStart: number | null = null;
  @state() private usageTimeSeriesCursorEnd: number | null = null;
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
  // The client survives transport reconnects, so retry budgets need a separate epoch.
  private connectionEpoch: object = {};
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () => this.usageLoading,
    reload: (reason) => {
      this.clearDateDebounce();
      const sessionKey =
        reason === "manual" && this.usageSelectedSessions.length === 1
          ? this.usageSelectedSessions[0]
          : undefined;
      return this.loadUsage(sessionKey);
    },
    onIncompleteUsageExhausted: () => this.requestUpdate(),
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetForClientChange(),
    invalidateRequests: (change) => {
      if (change.snapshot.phase === "connected") {
        return;
      }
      this.refreshPolicy.interrupt();
      this.usageRequest.cancel();
      this.details.cancel();
      this.usageExportRequest.cancel();
    },
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly observeAgentScope = watchAgentScope((scopeId) => {
    if (this.routeDataInitialized && this.usageAgentId !== scopeId) {
      this.usageAgentId = scopeId;
      this.clearSelectionsAndDetails();
      this.resetProviderUsage();
      this.refreshPolicy.request("manual");
    }
    this.requestUpdate();
  });

  private readonly usageRequest = createUsageRequest(this, {
    task: async (
      [client, refreshSessionKey]: readonly [GatewayBrowserClient, string | undefined],
      { signal },
    ) => {
      this.refreshPolicy.beginLoad();
      const epoch = this.connectionEpoch;
      return {
        epoch,
        refreshSessionKey,
        snapshot: await requestUsageSnapshot(
          client,
          {
            startDate: this.usageLoadStartDate,
            endDate: this.usageLoadEndDate,
            scope: this.usageScope,
            timeZone: this.usageTimeZone,
            agentId: normalizeLowercaseStringOrEmpty(this.usageAgentId ?? "") || undefined,
          },
          signal,
        ),
      };
    },
    onComplete: (value) => {
      const snapshot = value.snapshot;
      if (snapshot.ok) {
        this.usageResult = snapshot.value.result;
        this.usageCostSummary = snapshot.value.costSummary;
        this.usageError = null;
        const sessionKey =
          this.usageSelectedSessions.length === 1 ? this.usageSelectedSessions[0] : undefined;
        if (sessionKey) {
          // Manual intent belongs to this request's selection, never a later poll or selection.
          if (value.refreshSessionKey === sessionKey) {
            this.details.load(sessionKey);
          } else {
            void this.details.contextWeight.load(sessionKey);
          }
        }
      } else {
        this.applyUsageError(snapshot.error.cause);
      }
      this.applyUsageLoadState(
        providerUsageFromSnapshotResult(snapshot),
        value.epoch,
        snapshot.ok ? undefined : null,
      );
      this.refreshPolicy.flushPending();
    },
    onError: (error) => {
      this.applyUsageError(error);
      this.applyUsageLoadState({ state: "pending" }, this.connectionEpoch, null);
      this.refreshPolicy.flushPending();
    },
  });

  private readonly usageExportRequest = createUsageJsonExportRequest(this, this.gateway, () => ({
    startDate: this.usageLoadStartDate,
    endDate: this.usageLoadEndDate,
    scope: this.usageScope,
    timeZone: this.usageTimeZone,
    agentId: this.usageAgentId ?? undefined,
  }));

  private readonly details = new UsageDetailsController(
    this,
    this.gateway,
    () => ({
      startDate: this.usageStartDate,
      endDate: this.usageEndDate,
      scope: this.usageScope,
      timeZone: this.usageTimeZone,
      agentId: this.usageAgentId ?? undefined,
    }),
    () => this.usageResult?.sessions ?? [],
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agentSelection,
      (selection) => this.observeAgentScope(selection),
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

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.clearDateDebounce();
    this.clearQueryDebounce();
    this.refreshPolicy.dispose();
    this.usageRequest.cancel();
    this.details.cancel();
    this.usageExportRequest.cancel();
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
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.routeDataEnabled = false;
      return;
    }
    const currentAgentId = this.context.agentSelection.state.scopeId;
    if (data.query.agentId !== currentAgentId) {
      this.usageAgentId = currentAgentId;
      this.clearSelectionsAndDetails();
      this.resetProviderUsage();
      this.refreshPolicy.request("manual");
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
    this.applyUsageLoadState(data.providerUsage, this.connectionEpoch, data.loadedAtMs);
    this.usageError = data.error;
  }

  private ensureInitialData() {
    if (
      this.routeDataEnabled ||
      !this.routeDataInitialized ||
      !this.gateway.client ||
      !this.gateway.connected ||
      this.usageLoading
    ) {
      return;
    }
    void this.loadUsage();
  }

  private resetForClientChange() {
    this.clearDateDebounce();
    this.usageRequest.cancel();
    if (this.routeDataInitialized) {
      this.routeDataEnabled = false;
    }
    this.usageResult = null;
    this.usageCostSummary = null;
    this.resetProviderUsage();
    this.usageError = null;
    this.usageAgentId = this.context.agentSelection.state.scopeId;
    this.clearSelectionsAndDetails();
  }

  private resetProviderUsage() {
    this.providerUsageSummary = null;
    this.providerUsageUnavailable = false;
    this.providerUsageIncomplete = false;
    this.refreshPolicy.resetPayload();
  }

  private applyUsageLoadState(
    snapshot: ProviderUsageSnapshot,
    connection: unknown,
    loadedAtMs: number | null = Date.now(),
  ): void {
    if (snapshot.state === "settled") {
      const result = snapshot.result;
      this.providerUsageUnavailable = !result.ok;
      this.providerUsageIncomplete = !result.ok || isUsageIncomplete(result.value);
      if (result.ok && !this.providerUsageIncomplete) {
        this.providerUsageSummary = result.value;
      }
    }
    // Retained incomplete snapshots still need convergence after a failed load
    // or reconnect; an unknown failure alone must not create retry work.
    const incomplete = this.providerUsageIncomplete || this.usageCacheIncomplete;
    this.refreshPolicy.setLastLoadedAtMs(snapshot.state === "pending" ? null : loadedAtMs, {
      incomplete,
      connection,
    });
  }

  private get usageCacheIncomplete(): boolean {
    return isUsageCacheIncomplete(
      this.usageResult?.cacheStatus,
      this.usageCostSummary?.cacheStatus,
    );
  }

  private get providerUsageStalled(): boolean {
    return this.providerUsageIncomplete && this.refreshPolicy.incompleteUsageExhausted;
  }

  private applyUsageError(error: unknown) {
    const missingScope = isMissingOperatorReadScopeError(error);
    this.usageError = missingScope
      ? formatMissingOperatorReadScopeMessage("usage")
      : toUsageErrorMessage(error);
    if (missingScope) {
      this.usageResult = this.usageCostSummary = null;
    }
  }

  private get usageLoading(): boolean {
    return !this.routeDataInitialized || this.usageRequest.pending;
  }

  private loadUsage(refreshSessionKey?: string): Promise<void> {
    const client = this.gateway.client;
    if (!client || !this.gateway.connected) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    // Filter changes must supersede active work; the request fences the old result
    // so it cannot publish under the newly rendered query controls.
    this.routeDataEnabled = false;
    this.usageLoadStartDate = this.usageStartDate;
    this.usageLoadEndDate = this.usageEndDate;
    this.usageError = null;
    return this.usageRequest.run([client, refreshSessionKey]);
  }

  private clearSelections() {
    this.usageSelectedDays = [];
    this.usageSelectedHours = [];
    this.usageSelectedSessions = [];
  }

  private clearDetails() {
    this.details.clear();
    this.usageTimeSeriesCursorStart = null;
    this.usageTimeSeriesCursorEnd = null;
  }

  private clearSelectionsAndDetails() {
    this.usageExportRequest.cancel();
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
    // Cancel the old query's poll before it can consume this debounce and retry budget.
    this.refreshPolicy.resetPayload();
    this.routeDataEnabled = false;
    this.dateDebounceTimer = window.setTimeout(() => {
      this.dateDebounceTimer = null;
      this.refreshPolicy.request("manual");
    }, 400);
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    if (!this.gateway.connected || !this.gateway.client) {
      return;
    }
    void this.context.agents.ensureList();
    if (change.identityChanged || change.becameConnected) {
      this.connectionEpoch = {};
      if (this.routeDataInitialized) {
        this.refreshPolicy.request("reconnect");
      }
    }
    const sessionKey =
      this.usageSelectedSessions.length === 1 ? this.usageSelectedSessions[0] : undefined;
    if (change.becameAvailable && sessionKey) {
      for (const detail of [
        this.details.timeSeries,
        this.details.sessionLogs,
        this.details.contextWeight,
      ]) {
        void detail.recover(sessionKey, detail === this.details.contextWeight);
      }
    }
  }

  private clearQueryDebounce() {
    if (this.queryDebounceTimer !== null) {
      window.clearTimeout(this.queryDebounceTimer);
      this.queryDebounceTimer = null;
    }
  }

  private selectSession(key: string, shiftKey: boolean, orderedKeys: string[]) {
    this.clearDetails();
    this.usageRecentSessions = [
      key,
      ...this.usageRecentSessions.filter((entry) => entry !== key),
    ].slice(0, 8);

    this.usageSelectedSessions = selectUsageSessionKeys(
      this.usageSelectedSessions,
      key,
      orderedKeys,
      shiftKey,
    );

    if (this.usageSelectedSessions.length === 1) {
      const sessionKey = this.usageSelectedSessions[0];
      if (sessionKey) {
        this.details.load(sessionKey);
      }
    }
  }

  override render() {
    const props: UsageProps = {
      data: {
        loading: this.usageLoading,
        exporting: this.usageExportRequest.pending,
        error: this.usageError,
        sessions: this.usageResult?.sessions ?? [],
        agents:
          this.context.agents.state.agentsList?.agents.map((entry) => entry.id).filter(Boolean) ??
          [],
        sessionsLimitReached: (this.usageResult?.sessions.length ?? 0) >= 1000,
        totals: this.usageResult?.totals ?? null,
        aggregates: this.usageResult?.aggregates ?? null,
        costDaily: this.usageCostSummary?.daily ?? [],
        cacheRefresh: this.usageCacheIncomplete
          ? this.refreshPolicy.incompleteUsageExhausted
            ? "exhausted"
            : "retrying"
          : "complete",
        providerUsage: this.providerUsageSummary?.providers ?? [],
        providerUsageStalled: this.providerUsageStalled,
        providerUsageUnavailable: this.providerUsageUnavailable,
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
        context: {
          weight: this.details.contextWeight.data,
          loading: this.details.contextWeight.loading,
          status: this.details.contextWeight.status,
        },
        timeSeriesMode: this.usageTimeSeriesMode,
        timeSeriesBreakdownMode: this.usageTimeSeriesBreakdownMode,
        timeSeries: this.details.timeSeries.data,
        timeSeriesLoading: this.details.timeSeries.loading,
        timeSeriesStatus: this.details.timeSeries.status,
        timeSeriesCursorStart: this.usageTimeSeriesCursorStart,
        timeSeriesCursorEnd: this.usageTimeSeriesCursorEnd,
        sessionLogs: this.details.sessionLogs.data,
        sessionLogsLoading: this.details.sessionLogs.loading,
        sessionLogsStatus: this.details.sessionLogs.status,
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
            this.refreshPolicy.request("manual");
          },
          onAgentChange: (agentId) => {
            this.context.agentSelection.setScope(agentId);
          },
          onRefresh: () => this.refreshPolicy.request("manual"),
          onTimeZoneChange: (timeZone) => {
            this.usageTimeZone = timeZone;
            this.clearSelectionsAndDetails();
            this.refreshPolicy.request("manual");
          },
          onToggleHeaderPinned: () => (this.usageHeaderPinned = !this.usageHeaderPinned),
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
          onClearDays: () => (this.usageSelectedDays = []),
          onClearHours: () => (this.usageSelectedHours = []),
          onClearSessions: () => {
            this.usageSelectedSessions = [];
            this.clearDetails();
          },
          onClearFilters: () => this.clearSelectionsAndDetails(),
        },
        display: {
          onExportJson: (data) => {
            void this.usageExportRequest.run(data);
          },
          onChartModeChange: (mode) => (this.usageChartMode = mode),
          onDailyChartModeChange: (mode) => (this.usageDailyChartMode = mode),
          onSessionSortChange: (sort) => (this.usageSessionSort = sort),
          onSessionSortDirChange: (direction) => (this.usageSessionSortDir = direction),
          onSessionsTabChange: (tab) => (this.usageSessionsTab = tab),
          onToggleColumn: (column) => {
            this.usageVisibleColumns = this.usageVisibleColumns.includes(column)
              ? this.usageVisibleColumns.filter((entry) => entry !== column)
              : [...this.usageVisibleColumns, column];
          },
        },
        details: {
          onToggleContextExpanded: () => (this.usageContextExpanded = !this.usageContextExpanded),
          onToggleSessionLogsExpanded: () =>
            (this.usageSessionLogsExpanded = !this.usageSessionLogsExpanded),
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
          onSelectSession: (key, shiftKey, orderedKeys) =>
            this.selectSession(key, shiftKey, orderedKeys),
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
        },
      },
    };

    return renderUsagePageShell(this.context, this.usageResult, renderUsage(props));
  }
}

if (!customElements.get("openclaw-usage-page")) {
  customElements.define("openclaw-usage-page", UsagePage);
}
