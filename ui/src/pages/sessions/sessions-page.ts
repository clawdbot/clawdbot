import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import {
  requestCloudWorkerStop,
  resolveCloudWorkerStopAction,
} from "../../components/cloud-worker-stop.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { fetchSessionMenuWork } from "../../components/session-menu-work.ts";
import type { SessionMenuAction, SessionMenuWork } from "../../components/session-menu.ts";
import "../../components/session-menu.ts";
import { renderSessionsHubHeader } from "../../components/sessions-hub-header.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { openEditor } from "../../lib/editor-links.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  scopedSessionPullRequestKey,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../../lib/session-pull-requests.ts";
import type { SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import {
  DEFAULT_SESSION_LIST_QUERY,
  filterSessionRows,
  scopedAgentParamsForSession,
  type SessionArchivedFilter,
} from "../../lib/sessions/index.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import {
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  canDeleteSessionRows,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { isActiveWorkboardCard } from "../../lib/workboard/card-state.ts";
import { captureSessionToWorkboard } from "../../lib/workboard/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  searchVisibleSessionTranscripts,
  sessionAgentIdentityById,
  sessionAgentIds,
} from "./agent-scope.ts";
import { rememberSessionCustomGroup, sessionCategoryNames } from "./custom-groups.ts";
import { loadStoredGroupBy, saveStoredGroupBy } from "./page-state.ts";
import { renderSessions, type SessionsProps, type TranscriptSearchState } from "./view.ts";

const SESSIONS_DOCS_URL = "https://docs.openclaw.ai/concepts/session";

export type SessionsRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationContext["gateway"]["snapshot"];
  result: SessionsListResult | null;
  error: string | null;
  expandedSessionKey: string | null;
  statusFilter: SessionArchivedFilter;
};

type SessionsPageRequestScope = {
  epoch: number;
  context: ApplicationContext;
  gateway: ApplicationContext["gateway"];
  sessions: ApplicationContext["sessions"];
  workboard: ApplicationContext["workboard"];
  client: GatewayBrowserClient;
};

type SessionsPageMutationResult = "completed" | "failed" | "stale";

/** Type-only, so the dialog itself stays behind its lazy boundary. */
type InputDialogOpener = (typeof import("../../components/input-dialog.ts"))["showInputDialog"];

type SessionDeleteRow = Pick<GatewaySessionRow, "key" | "archived" | "sessionId">;

class SessionsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: SessionsRouteData;

  @state() private result: SessionsListResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private activeMinutes = "";
  @state() private limit = String(DEFAULT_SESSION_LIST_QUERY.limit);
  @state() private includeGlobal = true;
  @state() private includeUnknown = false;
  @state() private statusFilter: SessionArchivedFilter = "active";
  @state() private searchQuery = "";
  @state() private transcriptSearchQuery = "";
  @state() private submittedTranscriptSearchQuery = "";
  @state() private transcriptSearch: TranscriptSearchState = { status: "idle" };
  @state() private sortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() private sortDir: "asc" | "desc" = "desc";
  @state() private groupBy: SessionsGroupBy = loadStoredGroupBy();
  @state() private page = 0;
  @state() private pageSize = 25;
  @state() private selectedKeys = new Set<string>();
  @state() private sessionMenu: { key: string; x: number; y: number } | null = null;
  @state() private sessionMenuWork: SessionMenuWork | null = null;
  @state() private expandedSessionKey: string | null = null;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  private deepLinkSessionKey: string | null = null;
  @state() private checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() private checkpointTaskKey: string | null = null;
  @state() private checkpointBusyKey: string | null = null;
  @state() private checkpointErrorByKey: Record<string, string> = {};

  private sessionRequestId = 0;
  // Async completions belong to one context/capability/connection epoch. Bump
  // before releasing locks so stale finally blocks cannot clear newer work.
  private pageEpoch = 0;
  private routeDataInitialized = false;
  private routeDataEnabled = true;
  private appliedRouteData?: SessionsRouteData;
  private ignorePendingSharedRefresh = false;
  private sessionMutationPending = false;
  private sessionReloadQueued = false;
  private sharedSessionsResult: SessionsListResult | null = null;
  private sharedSessionsLoading = false;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private sessionMenuTrigger: HTMLElement | null = null;
  // Guards the async work fetch: a menu reopened for another session must not
  // adopt a stale response.
  private sessionMenuWorkVersion = 0;
  private hasBoundGatewaySource = false;
  private sessionsSource?: ApplicationContext["sessions"];
  private hasBoundSessionsSource = false;
  private readonly observeAgentScope = watchAgentScope(() => {
    this.resetTranscriptSearchState(this.transcriptSearchQuery);
    if (this.routeDataInitialized && !this.deepLinkSessionKey) {
      this.page = 0;
      this.selectedKeys = new Set();
      void this.loadSessions();
    }
    this.requestUpdate();
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.sessions,
      (sessions) => {
        const sourceChanged =
          this.hasBoundSessionsSource && !Object.is(this.sessionsSource, sessions);
        this.hasBoundSessionsSource = true;
        this.sessionsSource = sessions;
        if (sourceChanged) {
          this.invalidatePageWork();
          this.resetProviderState();
        }
        this.sharedSessionsResult = sessions.state.result;
        this.sharedSessionsLoading = sessions.state.loading;
        const cleanup = sessions.subscribe((snapshot) => {
          if (!Object.is(this.context?.sessions, sessions)) {
            return;
          }
          const resultChanged = snapshot.result !== this.sharedSessionsResult;
          const refreshCompleted = this.sharedSessionsLoading && !snapshot.loading;
          this.sharedSessionsResult = snapshot.result;
          this.sharedSessionsLoading = snapshot.loading;
          if (snapshot.loading || !this.routeDataInitialized || this.sessionMutationPending) {
            return;
          }
          if (this.ignorePendingSharedRefresh && refreshCompleted) {
            this.ignorePendingSharedRefresh = false;
            return;
          }
          if (resultChanged) {
            this.scheduleSessionReload();
          }
        });
        if (sourceChanged && this.routeDataInitialized) {
          this.scheduleSessionReload();
        }
        return cleanup;
      },
    )
    .watch(
      () => this.context?.agentIdentity,
      (agentIdentity, notify) => agentIdentity.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => this.observeAgentScope(agentSelection),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const resetForSourceBind = this.hasBoundGatewaySource;
        this.hasBoundGatewaySource = true;
        const cleanup = gateway.subscribe((snapshot) => {
          if (Object.is(this.context?.gateway, gateway)) {
            this.applyGatewaySnapshot(snapshot);
          }
        });
        this.applyGatewaySnapshot(gateway.snapshot, resetForSourceBind);
        return cleanup;
      },
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .watch(
      () => this.context?.workboard,
      (workboard, notify) => workboard.subscribe(notify),
    );

  private transcriptSearchArgs() {
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    return [
      snapshot?.phase === "connected" ? (snapshot.client ?? null) : null,
      this.submittedTranscriptSearchQuery,
      context ?? null,
      context?.agentSelection.state.scopeId ?? null,
      snapshot ? isGatewayMethodAdvertised(snapshot, "sessions.search") === true : false,
    ] as const;
  }

  private readonly transcriptSearchTask = new Task(this, {
    args: () => this.transcriptSearchArgs(),
    task: async ([client, query, context, _agentScope, advertised]) => {
      if (!client || !query || !context || !advertised) {
        return null;
      }
      const result = await searchVisibleSessionTranscripts({
        client,
        query,
        result: this.result,
        listSessions: context.sessions.list,
        listOptions: this.sessionListOptions(),
        resolveAgentId: (sessionKey) =>
          parseAgentSessionKey(sessionKey)?.agentId ?? this.sessionAgentId(sessionKey, context),
      });
      return {
        results: result.results,
        indexing: result.indexing === true,
        truncated: result.truncated === true,
      };
    },
    onComplete: (result) => {
      this.transcriptSearch = result ? { status: "results", ...result } : { status: "idle" };
    },
    onError: (error) => {
      this.transcriptSearch = { status: "error", message: formatUiError(error) };
    },
  });

  private readonly checkpointTask = new Task(this, {
    autoRun: false,
    args: () => [null, ""] as const,
    task: async ([scope, sessionKey]: readonly [SessionsPageRequestScope | null, string]) => {
      if (!scope || !sessionKey) {
        return initialState;
      }
      const checkpoints = await scope.sessions.listCheckpoints(sessionKey, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
      return { sessionKey, checkpoints };
    },
    onComplete: ({ sessionKey, checkpoints }) => {
      this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: checkpoints };
    },
    onError: (error) => {
      const sessionKey = this.checkpointTaskKey;
      if (sessionKey) {
        this.checkpointErrorByKey = {
          ...this.checkpointErrorByKey,
          [sessionKey]: formatUiError(error),
        };
      }
    },
  });

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") || changed.has("context")) {
      this.applyRouteData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidatePageWork();
    // Dialogs mount on document.body, so navigating away would otherwise leave
    // one over the destination, still submitting against this detached page.
    this.dialogLifecycle?.abort();
    this.gatewayClient = null;
    this.gatewayConnected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    resetForSourceBind = false,
  ) {
    const clientChanged = resetForSourceBind || snapshot.client !== this.gatewayClient;
    const connectionChanged = (snapshot.phase === "connected") !== this.gatewayConnected;
    const becameConnected = snapshot.phase === "connected" && !this.gatewayConnected;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.phase === "connected";
    if (clientChanged || connectionChanged) {
      this.invalidatePageWork();
      this.ignorePendingSharedRefresh = false;
    }
    if (clientChanged) {
      this.resetProviderState();
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.requestUpdate();
      return;
    }
    if (this.routeDataInitialized && (clientChanged || becameConnected)) {
      this.ignorePendingSharedRefresh = true;
      void this.loadSessions();
    }
    this.requestUpdate();
  }

  private invalidatePageWork() {
    this.pageEpoch += 1;
    this.sessionRequestId += 1;
    this.submittedTranscriptSearchQuery = "";
    this.transcriptSearch = { status: "idle" };
    void this.transcriptSearchTask.run(this.transcriptSearchArgs());
    this.resetCheckpointTask();
    this.sessionReloadQueued = false;
    this.loading = false;
    this.checkpointBusyKey = null;
    this.sessionMutationPending = false;
    this.closeSessionMenu();
  }

  private resetProviderState() {
    this.result = null;
    this.error = null;
    this.loading = false;
    this.resetTranscriptSearchState("");
    this.selectedKeys = new Set();
    this.expandedSessionKey = null;
    this.deepLinkSessionKey = null;
    this.checkpointItemsByKey = {};
    this.checkpointTaskKey = null;
    this.checkpointBusyKey = null;
    this.checkpointErrorByKey = {};
  }

  private captureRequestScope(): SessionsPageRequestScope | null {
    const context = this.context;
    if (!this.isConnected || !context) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    return {
      epoch: this.pageEpoch,
      context,
      gateway,
      sessions: context.sessions,
      workboard: context.workboard,
      client,
    };
  }

  private isRequestScopeCurrent(scope: SessionsPageRequestScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.isConnected &&
      this.pageEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      context.workboard === scope.workboard &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  private mutationDisabledReason(request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }): string | undefined {
    const access = readSessionMethodAccess(this.context?.gateway.snapshot, request);
    return access.allowed ? undefined : access.reason;
  }

  private requireMutationAccess(
    scope: SessionsPageRequestScope,
    request: {
      method: string;
      params?: unknown;
      requiredScope?: "operator.write" | "operator.admin";
    },
  ): boolean {
    const access = readSessionMethodAccess(scope.gateway.snapshot, request);
    if (access.allowed) {
      return true;
    }
    this.error = access.reason;
    return false;
  }

  private selectedDeleteDisabledReason(): string | undefined {
    const rowsByKey = new Map(this.result?.sessions.map((row) => [row.key, row]) ?? []);
    for (const key of this.selectedKeys) {
      const row = rowsByKey.get(key);
      const reason = this.mutationDisabledReason({
        method: "sessions.delete",
        params: {
          key,
          ...(row?.archived === true ? { archivedOnly: true } : {}),
        },
      });
      if (reason) {
        return reason;
      }
    }
    return undefined;
  }

  private applyRouteData() {
    const data = this.routeData;
    const context = this.context;
    if (!data || !context) {
      return;
    }
    if (data !== this.appliedRouteData) {
      this.appliedRouteData = data;
      this.routeDataEnabled = true;
    }
    this.routeDataInitialized = true;
    if (!this.routeDataEnabled) {
      return;
    }
    this.statusFilter = data.statusFilter;
    if (data.expandedSessionKey) {
      this.activeMinutes = "";
      this.limit = String(DEFAULT_SESSION_LIST_QUERY.limit);
      this.includeGlobal = true;
      this.includeUnknown = true;
      this.searchQuery = "";
      this.page = 0;
      this.selectedKeys = new Set();
    } else {
      this.activeMinutes = "";
      this.limit = String(DEFAULT_SESSION_LIST_QUERY.limit);
      this.includeGlobal = true;
      this.includeUnknown = false;
    }
    this.expandedSessionKey = data.expandedSessionKey;
    // Only route-driven expansion narrows the list query; interactive drawer
    // opens must keep loading the full roster (see sessionListOptions).
    this.deepLinkSessionKey = data.expandedSessionKey;
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.phase === "connected";
    if (data.gateway !== gateway || data.gatewaySnapshot !== snapshot) {
      this.routeDataEnabled = false;
      void this.loadSessions();
      if (data.expandedSessionKey) {
        void this.loadCheckpoint(data.expandedSessionKey);
      }
      return;
    }
    this.result = data.result
      ? filterSessionRows(data.result, { archivedFilter: data.statusFilter })
      : null;
    this.error = data.error;
    this.loading = false;
    const sharedSessions = context.sessions.state;
    this.ignorePendingSharedRefresh = sharedSessions.loading;
    this.ensureAgentIdentities(this.result);
    if (data.expandedSessionKey) {
      void this.loadCheckpoint(data.expandedSessionKey);
    }
  }

  private scheduleSessionReload() {
    if (this.sessionReloadQueued) {
      return;
    }
    this.sessionReloadQueued = true;
    const epoch = this.pageEpoch;
    queueMicrotask(() => {
      if (epoch !== this.pageEpoch) {
        return;
      }
      this.sessionReloadQueued = false;
      const context = this.context;
      const gateway = context?.gateway.snapshot;
      if (
        this.isConnected &&
        context &&
        gateway?.phase === "connected" &&
        gateway.client &&
        !context.sessions.state.loading
      ) {
        void this.loadSessions();
      }
    });
  }

  private sessionAgentId(
    key: string,
    context: ApplicationContext | undefined = this.context,
  ): string | undefined {
    if (!context) {
      return undefined;
    }
    const { agentId } = scopedAgentParamsForSession(
      {
        assistantAgentId: context.agentSelection.state.selectedId,
        hello: context.gateway.snapshot.hello,
      },
      key,
    );
    return agentId;
  }

  private sessionPathAgentId(key: string, context: ApplicationContext): string {
    return this.sessionAgentId(key, context) ?? resolveSessionNavigationAgentId(context);
  }

  private sessionListOptions() {
    // Narrow the query only for a route deep link (?session=...); an open
    // drawer is pure UI state and must not filter subsequent reloads.
    const deepLinkKey = this.deepLinkSessionKey;
    const scopeAgentId = this.context?.agentSelection.state.scopeId ?? undefined;
    return {
      activeMinutes:
        deepLinkKey || this.statusFilter !== "active"
          ? undefined
          : parseStrictPositiveInteger(this.activeMinutes),
      limit: deepLinkKey
        ? DEFAULT_SESSION_LIST_QUERY.limit
        : parseStrictPositiveInteger(this.limit),
      search: deepLinkKey ?? undefined,
      includeGlobal: deepLinkKey ? true : this.includeGlobal,
      includeUnknown: deepLinkKey ? true : this.includeUnknown,
      archivedFilter: this.statusFilter,
      ...(deepLinkKey
        ? { agentId: this.sessionAgentId(deepLinkKey) }
        : scopeAgentId
          ? { agentId: scopeAgentId }
          : {}),
    };
  }

  private async loadSessions() {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const requestId = ++this.sessionRequestId;
    const previous = this.result;
    this.routeDataEnabled = false;
    this.loading = true;
    this.error = null;
    try {
      const result = await scope.sessions.list(this.sessionListOptions());
      if (requestId !== this.sessionRequestId || !this.isRequestScopeCurrent(scope)) {
        return;
      }
      this.result = result
        ? filterSessionRows(result, { archivedFilter: this.statusFilter })
        : null;
      this.ensureAgentIdentities(this.result);
      const checkpointKey = this.reconcileCheckpointCache(previous, this.result);
      if (checkpointKey) {
        void this.loadCheckpoint(checkpointKey);
      }
    } catch (error) {
      if (requestId === this.sessionRequestId && this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (requestId === this.sessionRequestId && this.isRequestScopeCurrent(scope)) {
        this.loading = false;
      }
    }
  }

  private resetTranscriptSearchState(query: string) {
    this.transcriptSearchQuery = query;
    this.submittedTranscriptSearchQuery = "";
    this.transcriptSearch = { status: "idle" };
    void this.transcriptSearchTask.run(this.transcriptSearchArgs());
  }

  private updateTranscriptSearchQuery(query: string) {
    if (query === this.transcriptSearchQuery) {
      return;
    }
    // Editing invalidates the visible results and the in-flight query so a
    // late response cannot appear under different search text.
    this.resetTranscriptSearchState(query);
  }

  private clearTranscriptSearch() {
    this.resetTranscriptSearchState("");
  }

  private async runTranscriptSearch() {
    const query = this.transcriptSearchQuery.trim();
    if (!query) {
      this.clearTranscriptSearch();
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope || isGatewayMethodAdvertised(scope.gateway.snapshot, "sessions.search") !== true) {
      return;
    }
    this.transcriptSearchQuery = query;
    this.submittedTranscriptSearchQuery = query;
    this.transcriptSearch = { status: "loading" };
    await this.transcriptSearchTask.run(this.transcriptSearchArgs());
  }

  private ensureAgentIdentities(result: SessionsListResult | null) {
    const context = this.context;
    if (!context || !result) {
      return;
    }
    const agentIds = sessionAgentIds(result).filter(
      (agentId) => !context.agentIdentity.get(agentId),
    );
    if (agentIds.length === 0) {
      return;
    }
    void context.agentIdentity.ensure(agentIds);
  }

  private reconcileCheckpointCache(
    previous: SessionsListResult | null,
    result: SessionsListResult | null,
  ): string | null {
    const rows = new Map((result?.sessions ?? []).map((row) => [row.key, row] as const));
    const previousRows = new Map((previous?.sessions ?? []).map((row) => [row.key, row] as const));
    const nextItems = { ...this.checkpointItemsByKey };
    const nextErrors = { ...this.checkpointErrorByKey };
    let checkpointKey: string | null = null;
    for (const key of Object.keys(nextItems)) {
      const row = rows.get(key);
      const previousRow = previousRows.get(key);
      if (
        !row ||
        !previousRow ||
        previousRow.compactionCheckpointCount !== row.compactionCheckpointCount ||
        previousRow.latestCompactionCheckpoint?.checkpointId !==
          row.latestCompactionCheckpoint?.checkpointId
      ) {
        delete nextItems[key];
        delete nextErrors[key];
        if (this.expandedSessionKey === key) {
          checkpointKey = key;
        }
      }
    }
    this.checkpointItemsByKey = nextItems;
    this.checkpointErrorByKey = nextErrors;
    return checkpointKey;
  }

  private updateFilters(next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) {
    this.activeMinutes = next.activeMinutes;
    this.limit = next.limit;
    this.includeGlobal = next.includeGlobal;
    this.includeUnknown = next.includeUnknown;
    this.page = 0;
    this.selectedKeys = new Set();
    // Explicit filter edits leave deep-link mode; load the full roster.
    this.deepLinkSessionKey = null;
    void this.loadSessions();
  }

  private updateStatusFilter(statusFilter: SessionArchivedFilter) {
    const context = this.context;
    if (statusFilter === this.statusFilter || !context) {
      return;
    }
    this.statusFilter = statusFilter;
    this.page = 0;
    this.selectedKeys = new Set();
    this.deepLinkSessionKey = null;
    // Route navigation refetches (statusFilter is in loaderDeps); mask the old
    // view's rows until the new result applies via applyRouteData.
    this.loading = true;
    this.error = null;
    context.navigate(
      "sessions",
      statusFilter === "active" ? undefined : { search: `?status=${statusFilter}` },
    );
  }

  private async deleteSelected() {
    const keys = [...this.selectedKeys];
    if (keys.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const message = t(
      keys.length === 1
        ? "sessionsView.deleteSelectedConfirmOne"
        : "sessionsView.deleteSelectedConfirm",
      { count: String(keys.length) },
    );
    if (
      !(await showConfirmDialog({
        message,
        confirmLabel: t("common.delete"),
        danger: true,
      })) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    const rowsByKey = new Map(this.result?.sessions.map((row) => [row.key, row]) ?? []);
    // Only current row state may opt into write-scoped archive deletion.
    // Unknown selections stay unflagged and therefore admin-only.
    await this.deleteSessions(keys.map((key) => rowsByKey.get(key) ?? { key }));
  }

  private async deleteSessions(
    rows: SessionDeleteRow[],
    options: { deleteTranscript?: boolean } = {},
  ) {
    if (rows.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const requests = rows.map((row) => ({
      key: row.key,
      agentId: this.sessionAgentId(row.key, scope.context),
      ...options,
      ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
      ...(row.archived === true ? { archivedOnly: true } : {}),
    }));
    for (const params of requests) {
      if (!this.requireMutationAccess(scope, { method: "sessions.delete", params })) {
        return;
      }
    }
    this.sessionMutationPending = true;
    try {
      const result = await scope.sessions.deleteMany(requests);
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      // Dirty/unpushed checkouts survive deletion; point at the Worktrees page
      // instead of cascading one force-delete confirm per session.
      if (result.preservedWorktrees.length > 0) {
        window.alert(
          t("sessionsView.deletePreservedWorktrees", {
            count: String(result.preservedWorktrees.length),
            branches: result.preservedWorktrees.map((worktree) => worktree.branch).join(", "),
          }),
        );
      }
      if (result.deleted.length > 0) {
        const deleted = new Set(result.deleted);
        const selected = new Set(this.selectedKeys);
        for (const key of result.deleted) {
          selected.delete(key);
        }
        this.selectedKeys = selected;
        if (this.result) {
          const sessions = this.result.sessions.filter((row) => !deleted.has(row.key));
          this.result = {
            ...this.result,
            count: Math.max(0, this.result.count - (this.result.sessions.length - sessions.length)),
            sessions,
          };
        }
        if (this.expandedSessionKey && deleted.has(this.expandedSessionKey)) {
          this.expandedSessionKey = null;
        }
        if (this.deepLinkSessionKey && deleted.has(this.deepLinkSessionKey)) {
          this.deepLinkSessionKey = null;
        }
        const deletedCurrent = result.deleted.find((key) =>
          areUiSessionKeysEquivalent(key, scope.gateway.snapshot.sessionKey),
        );
        if (deletedCurrent) {
          const agentId =
            parseAgentSessionKey(deletedCurrent)?.agentId ??
            scope.context.agentSelection.state.selectedId ??
            "main";
          selectApplicationSession({
            selection: scope.context.agentSelection,
            gateway: scope.gateway,
            agentId,
            sessionKey: buildAgentMainSessionKey({
              agentId,
              mainKey: resolveUiConfiguredMainKey({
                agentsList: scope.context.agents.state.agentsList,
                hello: scope.gateway.snapshot.hello,
              }),
            }),
          });
        }
      }
      if (result.errors.length > 0) {
        this.error = formatUiExternalText(result.errors.join("; "));
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope)) {
        this.sessionMutationPending = false;
      }
    }
  }

  private async deleteAllArchived() {
    const scope = this.captureRequestScope();
    if (!scope || this.loading || this.sessionMutationPending) {
      return;
    }
    // The rendered list is bounded by the page's limit filter; re-enumerate the
    // full archived set so "all archived" means all of them. Any abnormal page
    // (failure, non-advancing offset) aborts: deleting a partial enumeration
    // would silently violate the "all archived" contract.
    let rows: GatewaySessionRow[];
    try {
      // One options snapshot for every page: filter edits made while pages load
      // must not mix populations; a deep link never narrows "all archived".
      const {
        search: _deepLinkSearch,
        agentId: _linkedAgentId,
        ...filters
      } = this.sessionListOptions();
      const agentId = scope.context.agentSelection.state.scopeId?.trim();
      const listOptions = { ...filters, ...(agentId ? { agentId } : {}) };
      const listed = await fetchPagedSessionRows({
        list: (offset) => scope.sessions.list({ ...listOptions, limit: 1000, offset }),
        isCurrent: () => this.isRequestScopeCurrent(scope),
        missingResultError:
          scope.sessions.state.error ?? "archived session enumeration returned no result",
        stalledPaginationError: "archived session enumeration did not advance",
        incompletePaginationError: "archived session enumeration was incomplete",
      });
      if (!listed) {
        return;
      }
      rows = listed;
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
      return;
    }
    const archivedRows = rows.filter((row) => row.archived === true);
    if (archivedRows.length === 0) {
      return;
    }
    if (
      !(await showConfirmDialog({
        message: t("sessionsView.deleteAllArchivedConfirm", {
          count: String(archivedRows.length),
        }),
        confirmLabel: t("common.delete"),
        danger: true,
      })) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await this.deleteSessions(archivedRows, { deleteTranscript: true });
  }

  private async deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await showConfirmDialog({
        message: t("sessionsView.deleteSessionConfirm", { session: label }),
        confirmLabel: t("common.delete"),
        danger: true,
      })) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    await this.deleteSessions([row]);
  }

  private async stopCloudWorker(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    const stopAction = resolveCloudWorkerStopAction(row.placement);
    if (!stopAction || (stopAction.method === "sessions.reclaim" && row.hasActiveRun === true)) {
      return;
    }
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await showConfirmDialog({
        message: t("sessionsView.stopCloudWorkerConfirm", { session: label }),
        confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
        danger: true,
      })) ||
      !this.isRequestScopeCurrent(scope) ||
      !this.requireMutationAccess(scope, stopAction)
    ) {
      return;
    }
    this.sessionMutationPending = true;
    try {
      const agentId = parseAgentSessionKey(row.key)?.agentId;
      const result = await requestCloudWorkerStop(scope.client, stopAction, {
        key: row.key,
        ...(agentId ? { agentId } : {}),
      });
      if (result && this.isRequestScopeCurrent(scope)) {
        showToast({
          message: t("sessionsView.cloudWorkerStopResult", {
            session: label,
            state: result.worker?.state ?? result.status,
          }),
        });
      }
      if (this.isRequestScopeCurrent(scope)) {
        await this.loadSessions();
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope)) {
        this.sessionMutationPending = false;
      }
    }
  }

  private knownCategories(): string[] {
    return sessionCategoryNames(this.result, this.context?.sessions.state.groups ?? []);
  }

  private setGroupBy(mode: SessionsGroupBy) {
    this.groupBy = mode;
    saveStoredGroupBy(mode);
  }

  private async rememberCustomGroup(
    name: string,
    scope: SessionsPageRequestScope | null = this.captureRequestScope(),
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      return "stale";
    }
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      })
    ) {
      return "failed";
    }
    return rememberSessionCustomGroup({
      name,
      knownCategories: this.knownCategories(),
      sessions: scope.sessions,
      isCurrent: () => this.isRequestScopeCurrent(scope),
      onError: (message) => {
        this.error = message;
      },
    });
  }

  private assignCategory(key: string, category: string | null) {
    // Only patch keys that exist in the current result; sessions.patch would
    // otherwise create a store entry for arbitrary dropped text.
    const session = this.result?.sessions.find((row) => row.key === key);
    if (!session) {
      return;
    }
    // Dropping a row onto its own section is a no-op; skip the patch round-trip.
    const current = session.category?.trim() || null;
    if (current === category) {
      return;
    }
    if (category) {
      void this.rememberCustomGroup(category);
    }
    void this.patchSession(key, { category });
  }

  /** Only one dialog is open at a time; disconnect closes whichever it is. */
  private dialogLifecycle: AbortController | null = null;

  private async withDialogLifecycle<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // A second open while one is live must not take ownership. showInputDialog
    // drops the reentrant request anyway, and if it installed its own controller
    // it would clear this field on the way out, leaving the dialog that is
    // actually on screen with nothing for disconnect to abort.
    const active = this.dialogLifecycle;
    if (active) {
      return run(active.signal);
    }
    const lifecycle = new AbortController();
    this.dialogLifecycle = lifecycle;
    try {
      return await run(lifecycle.signal);
    } finally {
      if (this.dialogLifecycle === lifecycle) {
        this.dialogLifecycle = null;
      }
    }
  }

  /** A dialog that never opens still owes the operator a visible outcome. */
  private async loadInputDialog(): Promise<InputDialogOpener | null> {
    try {
      return (await import("../../components/input-dialog.ts")).showInputDialog;
    } catch (error) {
      this.error = formatUiError(error);
      return null;
    }
  }

  private async requestNewCategory(sessionKey?: string) {
    await this.withDialogLifecycle(async (signal) => {
      const showInputDialog = await this.loadInputDialog();
      await showInputDialog?.({
        signal,
        title: t("sessionsView.newGroupTitle"),
        label: t("sessionsView.newGroupPrompt"),
        submitLabel: t("sessionsView.newGroupCreate"),
        requireValue: true,
        submit: (name) => this.writeNewCategory(name, sessionKey),
      });
    });
  }

  /**
   * One captured scope covers both writes: the catalog entry lands before the
   * row moves, and a catalog write that outlived its connection must not be
   * followed by an assignment issued on the replacement one.
   */
  private async writeNewCategory(name: string, sessionKey?: string): Promise<string | null> {
    this.error = null;
    const scope = this.captureRequestScope();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const remembered = await this.rememberCustomGroup(name, scope);
    if (remembered !== "completed") {
      return remembered === "failed"
        ? (this.error ?? t("sessionsView.newGroupFailed"))
        : t("sessionsView.newGroupStale");
    }
    if (!sessionKey) {
      return null;
    }
    // The catalog write is awaited first, so the row can leave this list in
    // between. sessions.patch would recreate a store entry for a key the list no
    // longer has, so the move is skipped — but this list is a bounded, filtered
    // projection, and a plain refresh can page a live row out of it. Skipping
    // silently would leave the operator with a new group, an unmoved session and
    // nothing explaining why, so the partial outcome is stated and terminal:
    // retrying here would only try to create the group that already exists.
    if (!this.result?.sessions.some((row) => row.key === sessionKey)) {
      this.error = t("sessionsView.newGroupMoveSkipped");
      return null;
    }
    const assigned = await this.patchSession(sessionKey, { category: name }, scope);
    if (assigned === "failed") {
      return this.error ?? t("sessionsView.newGroupFailed");
    }
    return assigned === "stale" ? t("sessionsView.newGroupStale") : null;
  }

  private async renameSession(row: GatewaySessionRow) {
    const value = await this.withDialogLifecycle(async (signal) => {
      const showInputDialog = await this.loadInputDialog();
      return (
        (await showInputDialog?.({
          signal,
          title: t("sessionsView.renameSessionPrompt"),
          defaultValue: normalizeOptionalString(row.label) ?? "",
        })) ?? null
      );
    });
    if (value === null) {
      return;
    }
    void this.patchSession(row.key, { label: normalizeOptionalString(value) ?? null });
  }

  private async patchSession(
    key: string,
    patch: Parameters<SessionsProps["onPatch"]>[1],
    scope: SessionsPageRequestScope | null = this.captureRequestScope(),
    expectedSessionId?: string,
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      // Nothing was attempted (e.g. rename dialog submitted after the gateway
      // dropped); say so instead of silently swallowing the edit.
      this.error = t("sessionsView.actionRequiresConnection");
      return "failed";
    }
    if (typeof patch.archived === "boolean" && !expectedSessionId?.trim()) {
      this.error = "Session lifecycle action requires a durable session identity.";
      return "failed";
    }
    const agentId = this.sessionAgentId(key, scope.context);
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.patch",
        params: { key, ...patch, ...(agentId ? { agentId } : {}) },
      })
    ) {
      return "failed";
    }
    try {
      const patched = await scope.sessions.patch(key, patch, {
        agentId,
        ...(typeof patch.archived === "boolean" ? { expectedSessionId } : {}),
      });
      if (!this.isRequestScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        this.error = scope.sessions.state.error;
        return "failed";
      }
      const selectedKeys = new Set(this.selectedKeys);
      selectedKeys.delete(key);
      this.selectedKeys = selectedKeys;
      return "completed";
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
        return "failed";
      }
      return "stale";
    }
  }

  private async archiveSessionWithUndo(row: GatewaySessionRow) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const result = await this.patchSession(row.key, { archived: true }, scope, row.sessionId);
    if (result !== "completed" || !this.isRequestScopeCurrent(scope)) {
      return;
    }
    // Undo is captured before showing the toast: the toast host outlives this
    // page, so the action must run against the shared mutations store (which
    // fails closed on connection replacement) rather than page scope — a
    // page-scope check would silently no-op after navigating away.
    const agentId = this.sessionAgentId(row.key, scope.context);
    showToast({
      message: t("sessionsView.sessionArchived"),
      actionLabel: t("common.undo"),
      onAction: () => {
        void scope.sessions.patch(
          row.key,
          { archived: false, ...(row.pinned === true ? { pinned: true } : {}) },
          { agentId, expectedSessionId: row.sessionId },
        );
      },
    });
  }

  private async forkSession(key: string, fromLastCompleted = false) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = this.sessionAgentId(key, scope.context);
    const createParams = {
      parentSessionKey: key,
      fork: true,
      ...(fromLastCompleted ? { forkFrom: "last-completed" as const } : {}),
      ...(agentId ? { agentId } : {}),
    };
    if (!this.requireMutationAccess(scope, { method: "sessions.create", params: createParams })) {
      return;
    }
    try {
      const forkedKey = await scope.sessions.create(createParams);
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      if (forkedKey) {
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: forkedKey,
            agentId: agentId ?? this.sessionPathAgentId(forkedKey, scope.context),
          }).options,
          hash: "",
        });
      } else if (scope.sessions.state.error) {
        this.error = scope.sessions.state.error;
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    }
  }

  private async toggleSessionDetails(sessionKey: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    this.deepLinkSessionKey = null;
    if (this.expandedSessionKey === sessionKey) {
      this.resetCheckpointTask();
      this.expandedSessionKey = null;
      return;
    }
    this.expandedSessionKey = sessionKey;
    const row = this.result?.sessions.find((session) => session.key === sessionKey);
    const hasCheckpoints =
      (row?.compactionCheckpointCount ?? 0) > 0 || Boolean(row?.latestCompactionCheckpoint);
    if (!hasCheckpoints) {
      if (!this.checkpointItemsByKey[sessionKey]) {
        this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: [] };
      }
      return;
    }
    if (this.checkpointItemsByKey[sessionKey]) {
      return;
    }
    await this.loadCheckpoint(sessionKey);
  }

  private async loadCheckpoint(sessionKey: string) {
    const scope = this.captureRequestScope();
    if (!scope) {
      // Rows stay expandable while disconnected; without an error the drawer
      // would claim "No checkpoints" beside a nonzero checkpoint badge.
      this.checkpointErrorByKey = {
        ...this.checkpointErrorByKey,
        [sessionKey]: t("sessionsView.actionRequiresConnection"),
      };
      return;
    }
    this.checkpointTaskKey = sessionKey;
    this.checkpointErrorByKey = { ...this.checkpointErrorByKey, [sessionKey]: "" };
    await this.checkpointTask.run([scope, sessionKey]);
  }

  private resetCheckpointTask() {
    this.checkpointTaskKey = null;
    void this.checkpointTask.run([null, ""]);
  }

  private get checkpointLoadingKey(): string | null {
    return this.checkpointTask.status === TaskStatus.PENDING ? this.checkpointTaskKey : null;
  }

  private async branchCheckpoint(sessionKey: string, checkpointId: string) {
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await showConfirmDialog({
        message: t("sessionsView.branchCheckpointConfirm"),
        confirmLabel: t("common.create"),
      })) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.compaction.branch",
        requiredScope: "operator.write",
      })
    ) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      const result = await scope.sessions.branchCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
      if (this.isRequestScopeCurrent(scope)) {
        scope.context.navigate("chat", {
          ...sessionNavigationTarget({
            context: scope.context,
            face: "chat",
            sessionKey: result.key,
            agentId: this.sessionPathAgentId(result.key, scope.context),
          }).options,
          hash: "",
        });
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope) && this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  private async restoreCheckpoint(sessionKey: string, checkpointId: string) {
    const scope = this.captureRequestScope();
    if (
      !scope ||
      !(await showConfirmDialog({
        message: t("sessionsView.restoreCheckpointConfirm"),
        confirmLabel: t("common.restore"),
        danger: true,
      })) ||
      !this.isRequestScopeCurrent(scope)
    ) {
      return;
    }
    if (
      !this.requireMutationAccess(scope, {
        method: "sessions.compaction.restore",
        requiredScope: "operator.admin",
      })
    ) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      await scope.sessions.restoreCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope) && this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  private openSessionMenu(
    row: GatewaySessionRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (this.sessionMenu?.key === row.key && trigger) {
      this.closeSessionMenu();
      return;
    }
    this.sessionMenu = { key: row.key, ...position };
    this.sessionMenuTrigger = trigger;
    this.loadSessionMenuWork(row);
  }

  private closeSessionMenu() {
    if (this.context) {
      sessionPullRequestsForGateway(this.context.gateway).unwatch(this);
    }
    this.sessionMenu = null;
    this.sessionMenuTrigger = null;
    this.sessionMenuWorkVersion += 1;
    this.sessionMenuWork = null;
  }

  private loadSessionMenuWork(row: GatewaySessionRow) {
    const version = ++this.sessionMenuWorkVersion;
    if (!row.worktree) {
      this.sessionMenuWork = null;
      return;
    }
    this.sessionMenuWork = { loading: true, pullRequestUrl: null, worktreePath: null };
    const scope = this.captureRequestScope();
    if (!scope) {
      this.sessionMenuWork = { loading: false, pullRequestUrl: null, worktreePath: null };
      return;
    }
    const store = sessionPullRequestsForGateway(scope.context.gateway);
    const pullRequestKey = scopedSessionPullRequestKey(
      row.key,
      this.sessionAgentId(row.key, scope.context),
    );
    void fetchSessionMenuWork({
      client: scope.client,
      pullRequestsAvailable:
        isGatewayMethodAdvertised(
          scope.context.gateway.snapshot,
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        ) === true,
      sessionKey: row.key,
      agentId: this.sessionAgentId(row.key, scope.context),
      loadPullRequests: () => store.load(this, pullRequestKey),
      worktreeId: row.worktree.id,
    }).then((work) => {
      if (version === this.sessionMenuWorkVersion) {
        this.sessionMenuWork = { loading: false, ...work };
      }
    });
  }

  private renderSessionMenu() {
    const menu = this.sessionMenu;
    const context = this.context;
    const row = menu ? this.result?.sessions.find((session) => session.key === menu.key) : null;
    if (!menu || !context || !row) {
      return nothing;
    }
    const gateway = context.gateway.snapshot;
    const canCapture =
      isWorkboardEnabledInConfigSnapshot(context.runtimeConfig.state.configSnapshot) &&
      hasOperatorWriteAccess(gateway.hello?.auth ?? null);
    const workboardState = context.workboard.state;
    const capturedSessionKeys = new Set(
      workboardState.cards
        .filter(isActiveWorkboardCard)
        .flatMap((card) => [card.sessionKey, card.execution?.sessionKey])
        .filter((key): key is string => typeof key === "string" && key.length > 0),
    );
    const configuredMainKey = resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: gateway.hello,
    });
    const archiveAllowed = canArchiveSessionRow(row, configuredMainKey);
    const deleteAllowed = canDeleteSessionRows([row], configuredMainKey);
    const cloudWorkerStopAction = resolveCloudWorkerStopAction(row.placement);
    const cloudWorkerStopAllowed = Boolean(
      cloudWorkerStopAction &&
      (cloudWorkerStopAction.method !== "sessions.reclaim" || row.hasActiveRun !== true) &&
      isGatewayMethodAdvertised(gateway, cloudWorkerStopAction.method) === true,
    );
    return html`
      <openclaw-session-menu
        .session=${{
          label: normalizeOptionalString(row.label) ?? row.key,
          pinned: row.pinned === true,
          unread: row.unread === true,
          archived: row.archived === true,
          category: normalizeOptionalString(row.category) ?? null,
          icon: normalizeOptionalString(row.icon) ?? null,
        }}
        .anchor=${menu}
        .trigger=${this.sessionMenuTrigger}
        .disabled=${this.loading}
        .actionDisabledReasons=${sessionMenuReasons({
          snapshot: gateway,
          session: row,
          cloudWorkerStopAction,
        })}
        .forkDisabled=${row.modelSelectionLocked === true}
        .forkFromLastCompleted=${row.hasActiveRun === true}
        .archiveAllowed=${archiveAllowed}
        .deleteAllowed=${deleteAllowed}
        .cloudWorkerStopAllowed=${cloudWorkerStopAllowed}
        .groups=${this.knownCategories()}
        .work=${this.sessionMenuWork}
        .workboard=${canCapture && row.kind !== "global"
          ? {
              captured: capturedSessionKeys.has(row.key),
              busy: workboardState.capturingSessionKeys.has(row.key),
            }
          : null}
        .onClose=${() => this.closeSessionMenu()}
        .onAction=${(action: SessionMenuAction) => {
          switch (action.kind) {
            case "open-pr":
              openExternalUrlSafe(action.url);
              break;
            case "open-in":
              openEditor(action.editor, action.path);
              break;
            case "toggle-pin":
              void this.patchSession(row.key, { pinned: row.pinned !== true });
              break;
            case "toggle-unread":
              void this.patchSession(row.key, { unread: row.unread !== true });
              break;
            case "rename":
              void this.renameSession(row);
              break;
            case "set-icon":
              void this.patchSession(row.key, { icon: action.icon });
              break;
            case "fork":
              void this.forkSession(row.key, row.hasActiveRun === true);
              break;
            case "workboard":
              void this.addToWorkboard(row);
              break;
            case "move-to-group":
              this.assignCategory(row.key, action.category);
              break;
            case "new-group":
              void this.requestNewCategory(row.key);
              break;
            case "toggle-archived":
              if (row.archived === true) {
                void this.patchSession(row.key, { archived: false }, undefined, row.sessionId);
              } else {
                void this.archiveSessionWithUndo(row);
              }
              break;
            case "stop-cloud-worker":
              void this.stopCloudWorker(row);
              break;
            case "delete":
              void this.deleteSessionFromMenu(row);
              break;
          }
        }}
      ></openclaw-session-menu>
    `;
  }

  override render() {
    const context = this.context;
    if (!context) {
      return html``;
    }
    return html`
      ${renderSessionsHubHeader({
        active: "sessions",
        title: titleForRoute("sessions"),
        subtitle: html`${subtitleForRoute("sessions")}
        ${renderDocsLink(SESSIONS_DOCS_URL, t("common.learnMore"))}`,
        actions: renderAgentScopeControl({
          agents: context.agents.state.agentsList?.agents ?? [],
          selection: context.agentSelection,
        }),
        onSelect: (tab) => {
          if (tab !== "sessions") {
            context.navigate(tab);
          }
        },
      })}
      ${renderSettingsWorkspace(
        renderSessions({
          loading: this.loading,
          result: this.result,
          error: this.error,
          activeMinutes: this.activeMinutes,
          limit: this.limit,
          includeGlobal: this.includeGlobal,
          includeUnknown: this.includeUnknown,
          statusFilter: this.statusFilter,
          basePath: context.basePath,
          agentId: resolveSessionNavigationAgentId(context),
          mainKey: resolveUiConfiguredMainKey({
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
          }),
          searchQuery: this.searchQuery,
          transcriptSearchAvailable:
            isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.search") === true,
          transcriptSearchQuery: this.transcriptSearchQuery,
          transcriptSearch:
            this.transcriptSearchTask.status === TaskStatus.PENDING
              ? { status: "loading" }
              : this.transcriptSearch,
          agentIdentityById: sessionAgentIdentityById(
            this.result,
            (agentId) => context.agentIdentity.get(agentId) ?? undefined,
          ),
          sortColumn: this.sortColumn,
          sortDir: this.sortDir,
          groupBy: this.groupBy,
          knownCategories: this.knownCategories(),
          page: this.page,
          pageSize: this.pageSize,
          selectedKeys: this.selectedKeys,
          sessionMenu: this.sessionMenu,
          expandedSessionKey: this.expandedSessionKey,
          checkpointItemsByKey: this.checkpointItemsByKey,
          checkpointLoadingKey: this.checkpointLoadingKey,
          checkpointBusyKey: this.checkpointBusyKey,
          checkpointErrorByKey: this.checkpointErrorByKey,
          patchWriteDisabledReason: this.mutationDisabledReason({
            method: "sessions.patch",
            params: { key: "", label: null },
          }),
          patchAdminDisabledReason: this.mutationDisabledReason({
            method: "sessions.patch",
            params: { key: "", thinkingLevel: null },
          }),
          groupWriteDisabledReason: this.mutationDisabledReason({
            method: "sessions.groups.put",
            requiredScope: "operator.write",
          }),
          deleteArchivedDisabledReason: this.mutationDisabledReason({
            method: "sessions.delete",
            params: { key: "", archivedOnly: true, deleteTranscript: true },
          }),
          checkpointBranchDisabledReason: this.mutationDisabledReason({
            method: "sessions.compaction.branch",
            requiredScope: "operator.write",
          }),
          checkpointRestoreDisabledReason: this.mutationDisabledReason({
            method: "sessions.compaction.restore",
            requiredScope: "operator.admin",
          }),
          deleteSelectedDisabledReason: this.selectedDeleteDisabledReason(),
          onFiltersChange: (next) => this.updateFilters(next),
          onClearFilters: () => {
            this.activeMinutes = "";
            this.limit = String(DEFAULT_SESSION_LIST_QUERY.limit);
            this.includeGlobal = true;
            this.includeUnknown = false;
            this.searchQuery = "";
            this.page = 0;
            this.selectedKeys = new Set();
            this.deepLinkSessionKey = null;
            void this.loadSessions();
          },
          onSearchChange: (query) => {
            this.searchQuery = query;
            this.page = 0;
            this.selectedKeys = new Set();
          },
          onTranscriptSearchChange: (query) => this.updateTranscriptSearchQuery(query),
          onTranscriptSearch: () => void this.runTranscriptSearch(),
          onClearTranscriptSearch: () => this.clearTranscriptSearch(),
          onSortChange: (column, direction) => {
            this.sortColumn = column;
            this.sortDir = direction;
            this.page = 0;
          },
          onGroupByChange: (mode) => this.setGroupBy(mode),
          onAssignCategory: (key, category) => this.assignCategory(key, category),
          onRequestNewCategory: (sessionKey) => void this.requestNewCategory(sessionKey),
          onPageChange: (page) => {
            this.page = page;
          },
          onPageSizeChange: (pageSize) => {
            this.pageSize = pageSize;
            this.page = 0;
          },
          onRefresh: () => void this.loadSessions(),
          onStatusFilterChange: (statusFilter) => this.updateStatusFilter(statusFilter),
          onDeleteAllArchived: () => void this.deleteAllArchived(),
          onPatch: (key, patch) => void this.patchSession(key, patch),
          onToggleSelect: (key) => {
            const next = new Set(this.selectedKeys);
            if (next.has(key)) {
              next.delete(key);
            } else {
              next.add(key);
            }
            this.selectedKeys = next;
          },
          onSelectPage: (keys) => {
            this.selectedKeys = new Set([...this.selectedKeys, ...keys]);
          },
          onDeselectPage: (keys) => {
            const next = new Set(this.selectedKeys);
            for (const key of keys) {
              next.delete(key);
            }
            this.selectedKeys = next;
          },
          onDeselectAll: () => {
            this.selectedKeys = new Set();
          },
          onDeleteSelected: () => void this.deleteSelected(),
          onNavigateToChat: (sessionKey) => {
            const face = resolveSessionPreferredFaceForKey(context, sessionKey);
            context.navigate(face, {
              ...sessionNavigationTarget({
                context,
                face,
                sessionKey,
                agentId: this.sessionPathAgentId(sessionKey, context),
                preferenceDerivedFace: true,
              }).options,
              hash: "",
            });
          },
          onOpenSessionMenu: (row, position, trigger) =>
            this.openSessionMenu(row, position, trigger),
          onToggleDetails: (sessionKey) => void this.toggleSessionDetails(sessionKey),
          onBranchFromCheckpoint: (sessionKey, checkpointId) =>
            void this.branchCheckpoint(sessionKey, checkpointId),
          onRestoreCheckpoint: (sessionKey, checkpointId) =>
            void this.restoreCheckpoint(sessionKey, checkpointId),
        }),
        { id: "sessions-hub-panel" },
      )}
      ${this.renderSessionMenu()}
    `;
  }

  private async addToWorkboard(session: GatewaySessionRow) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    try {
      await captureSessionToWorkboard({
        host: scope.workboard,
        client: scope.client,
        session,
        requestUpdate: () => {
          if (this.isRequestScopeCurrent(scope)) {
            scope.workboard.notify();
          }
        },
      });
      if (this.isRequestScopeCurrent(scope)) {
        scope.context.navigate("workboard");
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = formatUiError(error);
      }
    }
  }
}

if (!customElements.get("openclaw-sessions-page")) {
  customElements.define("openclaw-sessions-page", SessionsPage);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
