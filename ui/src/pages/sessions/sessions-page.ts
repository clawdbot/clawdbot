import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import {
  loadStoredSessionCustomGroups,
  saveStoredSessionCustomGroups,
} from "../../lib/sessions/custom-groups.ts";
import { normalizeSessionsGroupBy, type SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import {
  filterSessionRows,
  scopedAgentParamsForSession,
  searchForSession,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { captureSessionToWorkboard } from "../../lib/workboard/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderSessions, type SessionsProps } from "./view.ts";

const GROUP_BY_STORAGE_KEY = "openclaw:sessions:group-by";

function loadStoredGroupBy(): SessionsGroupBy {
  return normalizeSessionsGroupBy(getSafeLocalStorage()?.getItem(GROUP_BY_STORAGE_KEY));
}

export type SessionsRouteData = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  result: SessionsListResult | null;
  error: string | null;
  expandedSessionKey: string | null;
  showArchived: boolean;
};

function parseFilterInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

class SessionsPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: SessionsRouteData;

  @state() private result: SessionsListResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private activeMinutes = "60";
  @state() private limit = "50";
  @state() private includeGlobal = true;
  @state() private includeUnknown = false;
  @state() private showArchived = false;
  @state() private searchQuery = "";
  @state() private sortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() private sortDir: "asc" | "desc" = "desc";
  @state() private groupBy: SessionsGroupBy = loadStoredGroupBy();
  @state() private customGroups: string[] = loadStoredSessionCustomGroups();
  @state() private page = 0;
  @state() private pageSize = 25;
  @state() private selectedKeys = new Set<string>();
  @state() private expandedSessionKey: string | null = null;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  private deepLinkSessionKey: string | null = null;
  @state() private checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() private checkpointLoadingKey: string | null = null;
  @state() private checkpointBusyKey: string | null = null;
  @state() private checkpointErrorByKey: Record<string, string> = {};

  private stopSessionSubscription?: () => void;
  private stopAgentIdentitySubscription?: () => void;
  private stopAgentSelectionSubscription?: () => void;
  private stopGatewaySubscription?: () => void;
  private stopRuntimeConfigSubscription?: () => void;
  private stopWorkboardSubscription?: () => void;
  private sessionRequestId = 0;
  private checkpointRequestId = 0;
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

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.startSessionState();
    this.startAgentIdentityState();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("routeData") || changed.has("context")) {
      this.applyRouteData();
    }
  }

  override updated() {
    this.startSessionState();
    this.startAgentIdentityState();
    this.startApplicationState();
  }

  override disconnectedCallback() {
    this.stopSessionSubscription?.();
    this.stopSessionSubscription = undefined;
    this.stopAgentIdentitySubscription?.();
    this.stopAgentIdentitySubscription = undefined;
    this.stopAgentSelectionSubscription?.();
    this.stopAgentSelectionSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    this.stopRuntimeConfigSubscription?.();
    this.stopRuntimeConfigSubscription = undefined;
    this.stopWorkboardSubscription?.();
    this.stopWorkboardSubscription = undefined;
    this.sessionRequestId += 1;
    this.checkpointRequestId += 1;
    this.sessionReloadQueued = false;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    super.disconnectedCallback();
  }

  private startSessionState() {
    const context = this.context;
    if (!context || this.stopSessionSubscription) {
      return;
    }
    this.sharedSessionsResult = context.sessions.state.result;
    this.sharedSessionsLoading = context.sessions.state.loading;
    this.stopSessionSubscription = context.sessions.subscribe((snapshot) => {
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
  }

  private startAgentIdentityState() {
    const context = this.context;
    if (!context || this.stopAgentIdentitySubscription) {
      return;
    }
    this.stopAgentIdentitySubscription = context.agentIdentity.subscribe(() =>
      this.requestUpdate(),
    );
  }

  private startApplicationState() {
    const context = this.context;
    if (!context || this.stopGatewaySubscription) {
      return;
    }
    this.stopAgentSelectionSubscription = context.agentSelection.subscribe(() =>
      this.requestUpdate(),
    );
    const gateway = context.gateway.snapshot;
    this.gatewayClient = gateway.client;
    this.gatewayConnected = gateway.connected;
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(snapshot),
    );
    this.stopRuntimeConfigSubscription = context.runtimeConfig.subscribe(() =>
      this.requestUpdate(),
    );
    this.stopWorkboardSubscription = context.workboard.subscribe(() => this.requestUpdate());
  }

  private applyGatewaySnapshot(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    const clientChanged = snapshot.client !== this.gatewayClient;
    const becameConnected = snapshot.connected && !this.gatewayConnected;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (clientChanged) {
      this.ignorePendingSharedRefresh = false;
      this.sessionRequestId += 1;
      this.checkpointRequestId += 1;
      this.result = null;
      this.error = null;
      this.loading = false;
      this.selectedKeys = new Set();
      this.expandedSessionKey = null;
      this.deepLinkSessionKey = null;
      this.checkpointItemsByKey = {};
      this.checkpointLoadingKey = null;
      this.checkpointBusyKey = null;
      this.checkpointErrorByKey = {};
    }
    if (!snapshot.connected || !snapshot.client) {
      this.sessionRequestId += 1;
      this.loading = false;
      this.requestUpdate();
      return;
    }
    if (this.routeDataInitialized && (clientChanged || becameConnected)) {
      this.ignorePendingSharedRefresh = true;
      void this.loadSessions();
    }
    this.requestUpdate();
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
    this.showArchived = data.showArchived;
    if (data.expandedSessionKey) {
      this.activeMinutes = "";
      this.limit = "";
      this.includeGlobal = true;
      this.includeUnknown = true;
      this.searchQuery = "";
      this.page = 0;
      this.selectedKeys = new Set();
    } else {
      this.activeMinutes = "60";
      this.limit = "50";
      this.includeGlobal = true;
      this.includeUnknown = false;
    }
    this.expandedSessionKey = data.expandedSessionKey;
    // Only route-driven expansion narrows the list query; interactive drawer
    // opens must keep loading the full roster (see sessionListOptions).
    this.deepLinkSessionKey = data.expandedSessionKey;
    const gateway = context.gateway.snapshot;
    if (data.client !== gateway.client || data.connected !== gateway.connected) {
      this.routeDataEnabled = false;
      void this.loadSessions();
      if (data.expandedSessionKey) {
        void this.loadCheckpoint(data.expandedSessionKey);
      }
      return;
    }
    this.result = data.result
      ? filterSessionRows(data.result, { showArchived: data.showArchived })
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
    queueMicrotask(() => {
      this.sessionReloadQueued = false;
      const context = this.context;
      const gateway = context?.gateway.snapshot;
      if (
        this.isConnected &&
        context &&
        gateway?.connected &&
        gateway.client &&
        !context.sessions.state.loading
      ) {
        void this.loadSessions();
      }
    });
  }

  private sessionAgentId(key: string): string | undefined {
    const context = this.context;
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

  private sessionListOptions() {
    // Narrow the query only for a route deep link (?session=...); an open
    // drawer is pure UI state and must not filter subsequent reloads.
    const deepLinkKey = this.deepLinkSessionKey;
    return {
      activeMinutes: deepLinkKey || this.showArchived ? 0 : parseFilterInteger(this.activeMinutes),
      limit: deepLinkKey ? 50 : parseFilterInteger(this.limit),
      search: deepLinkKey ?? undefined,
      includeGlobal: deepLinkKey ? true : this.includeGlobal,
      includeUnknown: deepLinkKey ? true : this.includeUnknown,
      showArchived: this.showArchived,
      ...(deepLinkKey ? { agentId: this.sessionAgentId(deepLinkKey) } : {}),
    };
  }

  private async loadSessions() {
    const context = this.context;
    if (!context) {
      return;
    }
    const requestId = ++this.sessionRequestId;
    const previous = this.result;
    this.routeDataEnabled = false;
    this.loading = true;
    this.error = null;
    try {
      const result = await context.sessions.list(this.sessionListOptions());
      if (requestId !== this.sessionRequestId) {
        return;
      }
      this.result = result ? filterSessionRows(result, { showArchived: this.showArchived }) : null;
      this.ensureAgentIdentities(this.result);
      const checkpointKey = this.reconcileCheckpointCache(previous, this.result);
      if (checkpointKey) {
        void this.loadCheckpoint(checkpointKey);
      }
    } catch (error) {
      if (requestId === this.sessionRequestId) {
        this.error = String(error);
      }
    } finally {
      if (requestId === this.sessionRequestId) {
        this.loading = false;
      }
    }
  }

  private ensureAgentIdentities(result: SessionsListResult | null) {
    const context = this.context;
    if (!context || !result) {
      return;
    }
    const agentIds = this.sessionAgentIds(result).filter(
      (agentId) => !context.agentIdentity.get(agentId),
    );
    if (agentIds.length === 0) {
      return;
    }
    void context.agentIdentity.ensure(agentIds);
  }

  private sessionAgentIds(result: SessionsListResult | null): string[] {
    return [
      ...new Set(
        (result?.sessions ?? [])
          .map((row) => parseAgentSessionKey(row.key)?.agentId)
          .filter((agentId): agentId is string => Boolean(agentId)),
      ),
    ];
  }

  private sessionAgentIdentityById(
    result: SessionsListResult | null,
  ): Record<string, AgentIdentityResult> {
    const context = this.context;
    if (!context) {
      return {};
    }
    return Object.fromEntries(
      this.sessionAgentIds(result)
        .map((agentId) => [agentId, context.agentIdentity.get(agentId)] as const)
        .filter((entry): entry is readonly [string, AgentIdentityResult] => Boolean(entry[1])),
    );
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
    showArchived: boolean;
  }) {
    this.activeMinutes = next.activeMinutes;
    this.limit = next.limit;
    this.includeGlobal = next.includeGlobal;
    this.includeUnknown = next.includeUnknown;
    this.showArchived = next.showArchived;
    this.page = 0;
    this.selectedKeys = new Set();
    // Explicit filter edits leave deep-link mode; load the full roster.
    this.deepLinkSessionKey = null;
    void this.loadSessions();
  }

  private async deleteSelected() {
    const context = this.context;
    const keys = [...this.selectedKeys];
    if (
      !context ||
      keys.length === 0 ||
      this.loading ||
      !context.hostPolicy.canInvokeAction("sessions.delete")
    ) {
      return;
    }
    if (
      !window.confirm(
        `Delete ${keys.length} ${keys.length === 1 ? "session" : "sessions"}?\n\nThis will delete the session entries and archive their transcripts.`,
      )
    ) {
      return;
    }
    this.sessionMutationPending = true;
    const result = await context.sessions
      .deleteMany(
        keys.map((key) => ({
          key,
          agentId: this.sessionAgentId(key),
        })),
      )
      .finally(() => {
        this.sessionMutationPending = false;
      });
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
    }
    if (result.errors.length > 0) {
      this.error = result.errors.join("; ");
    }
  }

  private knownCategories(): string[] {
    const fromRows = (this.result?.sessions ?? [])
      .map((row) => row.category?.trim())
      .filter((name): name is string => Boolean(name));
    return [...new Set([...this.customGroups, ...fromRows.toSorted((a, b) => a.localeCompare(b))])];
  }

  private setGroupBy(mode: SessionsGroupBy) {
    this.groupBy = mode;
    try {
      getSafeLocalStorage()?.setItem(GROUP_BY_STORAGE_KEY, mode);
    } catch {
      // ignore storage failures
    }
  }

  private rememberCustomGroup(name: string) {
    if (!this.customGroups.includes(name)) {
      this.customGroups = [...this.customGroups, name];
      saveStoredSessionCustomGroups(this.customGroups);
    }
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
      this.rememberCustomGroup(category);
    }
    void this.patchSession(key, { category });
  }

  private requestNewCategory(sessionKey?: string) {
    const raw = window.prompt(t("sessionsView.newGroupPrompt"));
    const name = raw?.trim();
    if (!name) {
      return;
    }
    this.rememberCustomGroup(name);
    if (sessionKey) {
      void this.patchSession(sessionKey, { category: name });
    }
  }

  private async patchSession(key: string, patch: Parameters<SessionsProps["onPatch"]>[1]) {
    const context = this.context;
    if (!context) {
      return;
    }
    try {
      const patched = await context.sessions.patch(key, patch, {
        agentId: this.sessionAgentId(key),
      });
      if (!patched) {
        this.error = context.sessions.state.error;
        return;
      }
      const selectedKeys = new Set(this.selectedKeys);
      selectedKeys.delete(key);
      this.selectedKeys = selectedKeys;
      if (
        patch.archived === true &&
        areUiSessionKeysEquivalent(key, context.gateway.snapshot.sessionKey)
      ) {
        context.gateway.setSessionKey(
          buildAgentMainSessionKey({
            agentId:
              parseAgentSessionKey(key)?.agentId ??
              context.agentSelection.state.selectedId ??
              "main",
            mainKey: resolveUiConfiguredMainKey({
              agentsList: context.agents.state.agentsList,
              hello: context.gateway.snapshot.hello,
            }),
          }),
        );
      }
    } catch (error) {
      this.error = String(error);
    }
  }

  private async forkSession(key: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    const agentId = this.sessionAgentId(key);
    const forkedKey = await context.sessions.create({
      parentSessionKey: key,
      fork: true,
      ...(agentId ? { agentId } : {}),
    });
    if (forkedKey) {
      context.navigate("chat", { search: searchForSession(forkedKey), hash: "" });
    } else if (context.sessions.state.error) {
      this.error = context.sessions.state.error;
    }
  }

  private async toggleSessionDetails(sessionKey: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    // Any interactive toggle ends deep-link mode so reloads return the roster.
    this.deepLinkSessionKey = null;
    if (this.expandedSessionKey === sessionKey) {
      this.checkpointRequestId += 1;
      this.expandedSessionKey = null;
      return;
    }
    this.expandedSessionKey = sessionKey;
    // Every row opens the details drawer; only fetch compaction history when
    // the row reports checkpoints, so plain sessions skip the round-trip.
    const row = this.result?.sessions.find((session) => session.key === sessionKey);
    const hasCheckpoints =
      (row?.compactionCheckpointCount ?? 0) > 0 || Boolean(row?.latestCompactionCheckpoint);
    if (!hasCheckpoints) {
      // Seed an empty cache entry so reconcileCheckpointCache sees this key
      // and reloads the open drawer if the session compacts on a refresh.
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
    const context = this.context;
    if (!context) {
      return;
    }
    const requestId = ++this.checkpointRequestId;
    this.checkpointLoadingKey = sessionKey;
    this.checkpointErrorByKey = { ...this.checkpointErrorByKey, [sessionKey]: "" };
    try {
      const checkpoints = await context.sessions.listCheckpoints(sessionKey, {
        agentId: this.sessionAgentId(sessionKey),
      });
      if (requestId !== this.checkpointRequestId) {
        return;
      }
      this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: checkpoints };
    } catch (error) {
      if (requestId !== this.checkpointRequestId) {
        return;
      }
      this.checkpointErrorByKey = {
        ...this.checkpointErrorByKey,
        [sessionKey]: String(error),
      };
    } finally {
      if (requestId === this.checkpointRequestId && this.checkpointLoadingKey === sessionKey) {
        this.checkpointLoadingKey = null;
      }
    }
  }

  private async branchCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (!window.confirm("Create a new child session from this compacted checkpoint?")) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      const result = await context.sessions.branchCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
      context.navigate("chat", { search: searchForSession(result.key), hash: "" });
    } catch (error) {
      this.error = String(error);
    } finally {
      if (this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  private async restoreCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (
      !window.confirm(
        "Restore this session to the selected compacted checkpoint?\n\nThis replaces the current active transcript for the session key.",
      )
    ) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      await context.sessions.restoreCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
    } catch (error) {
      this.error = String(error);
    } finally {
      if (this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  override render() {
    const context = this.context;
    if (!context) {
      return html``;
    }
    const gateway = context.gateway.snapshot;
    const workboardEnabled = isWorkboardEnabledInConfigSnapshot(
      context.runtimeConfig.state.configSnapshot,
    );
    const canCapture = workboardEnabled && hasOperatorWriteAccess(gateway.hello?.auth ?? null);
    const workboardState = context.workboard.state;
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("sessions")}</div>
          <div class="page-sub">${subtitleForRoute("sessions")}</div>
        </div>
      </section>
      ${renderSessions({
        loading: this.loading,
        result: this.result,
        error: this.error,
        activeMinutes: this.activeMinutes,
        limit: this.limit,
        includeGlobal: this.includeGlobal,
        includeUnknown: this.includeUnknown,
        showArchived: this.showArchived,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        }),
        basePath: context.basePath,
        searchQuery: this.searchQuery,
        agentIdentityById: this.sessionAgentIdentityById(this.result),
        sortColumn: this.sortColumn,
        sortDir: this.sortDir,
        groupBy: this.groupBy,
        knownCategories: this.knownCategories(),
        page: this.page,
        pageSize: this.pageSize,
        selectedKeys: this.selectedKeys,
        canDeleteSessions: context.hostPolicy.canInvokeAction("sessions.delete"),
        workboardSessionKeys: new Set(
          workboardState.cards
            .flatMap((card) => [card.sessionKey, card.execution?.sessionKey])
            .filter((key): key is string => typeof key === "string" && key.length > 0),
        ),
        workboardBusySessionKey: [...workboardState.capturingSessionKeys][0] ?? null,
        expandedSessionKey: this.expandedSessionKey,
        checkpointItemsByKey: this.checkpointItemsByKey,
        checkpointLoadingKey: this.checkpointLoadingKey,
        checkpointBusyKey: this.checkpointBusyKey,
        checkpointErrorByKey: this.checkpointErrorByKey,
        onFiltersChange: (next) => this.updateFilters(next),
        onClearFilters: () => {
          this.activeMinutes = "";
          this.limit = "";
          this.includeGlobal = true;
          this.includeUnknown = true;
          this.showArchived = false;
          this.searchQuery = "";
          this.page = 0;
          this.selectedKeys = new Set();
          this.deepLinkSessionKey = null;
          void this.loadSessions();
        },
        onSearchChange: (query) => {
          this.searchQuery = query;
          this.page = 0;
        },
        onSortChange: (column, direction) => {
          this.sortColumn = column;
          this.sortDir = direction;
          this.page = 0;
        },
        onGroupByChange: (mode) => this.setGroupBy(mode),
        onAssignCategory: (key, category) => this.assignCategory(key, category),
        onRequestNewCategory: (sessionKey) => this.requestNewCategory(sessionKey),
        onPageChange: (page) => {
          this.page = page;
        },
        onPageSizeChange: (pageSize) => {
          this.pageSize = pageSize;
          this.page = 0;
        },
        onRefresh: () => void this.loadSessions(),
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
        onNavigateToChat: (sessionKey) =>
          context.navigate("chat", { search: searchForSession(sessionKey), hash: "" }),
        onFork: (sessionKey) => this.forkSession(sessionKey),
        onAddToWorkboard: canCapture
          ? (session: GatewaySessionRow) => this.addToWorkboard(session)
          : undefined,
        onToggleDetails: (sessionKey) => void this.toggleSessionDetails(sessionKey),
        onBranchFromCheckpoint: (sessionKey, checkpointId) =>
          void this.branchCheckpoint(sessionKey, checkpointId),
        onRestoreCheckpoint: (sessionKey, checkpointId) =>
          void this.restoreCheckpoint(sessionKey, checkpointId),
      })}
    `;
  }

  private async addToWorkboard(session: GatewaySessionRow) {
    const context = this.context;
    if (!context) {
      return;
    }
    await captureSessionToWorkboard({
      host: context.workboard,
      client: context.gateway.snapshot.client,
      session,
      requestUpdate: context.workboard.notify,
    });
    context.navigate("workboard");
  }
}

if (!customElements.get("openclaw-sessions-page")) {
  customElements.define("openclaw-sessions-page", SessionsPage);
}
