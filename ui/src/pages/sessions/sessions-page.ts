import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
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
import "../../components/session-menu.ts";
import type { SessionMenuAction } from "../../components/session-menu.ts";
import { t } from "../../i18n/index.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { normalizeSessionsGroupBy, type SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import {
  filterSessionRows,
  scopedAgentParamsForSession,
  searchForSession,
} from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  canArchiveSessionRow,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { captureSessionToWorkboard } from "../../lib/workboard/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderSessions, type SessionsProps } from "./view.ts";

const GROUP_BY_STORAGE_KEY = "openclaw:sessions:group-by";

function loadStoredGroupBy(): SessionsGroupBy {
  return normalizeSessionsGroupBy(getSafeLocalStorage()?.getItem(GROUP_BY_STORAGE_KEY));
}

export type SessionsRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationContext["gateway"]["snapshot"];
  result: SessionsListResult | null;
  error: string | null;
  expandedSessionKey: string | null;
  showArchived: boolean;
};

type SessionsPageRequestScope = {
  epoch: number;
  context: ApplicationContext;
  gateway: ApplicationContext["gateway"];
  sessions: ApplicationContext["sessions"];
  workboard: ApplicationContext["workboard"];
  client: GatewayBrowserClient;
};

function parseFilterInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

class SessionsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
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
  @state() private page = 0;
  @state() private pageSize = 25;
  @state() private selectedKeys = new Set<string>();
  @state() private sessionMenu: { key: string; x: number; y: number } | null = null;
  @state() private expandedSessionKey: string | null = null;
  // Route deep-link target (?session=...); unlike expandedSessionKey it also
  // narrows sessionListOptions so the linked session is guaranteed to load.
  private deepLinkSessionKey: string | null = null;
  @state() private checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() private checkpointLoadingKey: string | null = null;
  @state() private checkpointBusyKey: string | null = null;
  @state() private checkpointErrorByKey: Record<string, string> = {};

  private sessionRequestId = 0;
  private checkpointRequestId = 0;
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
  private hasBoundGatewaySource = false;
  private sessionsSource?: ApplicationContext["sessions"];
  private hasBoundSessionsSource = false;
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
    .watch(
      () => this.context?.agentSelection,
      (agentSelection, notify) => agentSelection.subscribe(notify),
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

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") || changed.has("context")) {
      this.applyRouteData();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidatePageWork();
    this.gatewayClient = null;
    this.gatewayConnected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    resetForSourceBind = false,
  ) {
    const clientChanged = resetForSourceBind || snapshot.client !== this.gatewayClient;
    const connectionChanged = snapshot.connected !== this.gatewayConnected;
    const becameConnected = snapshot.connected && !this.gatewayConnected;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (clientChanged || connectionChanged) {
      this.invalidatePageWork();
      this.ignorePendingSharedRefresh = false;
    }
    if (clientChanged) {
      this.resetProviderState();
    }
    if (!snapshot.connected || !snapshot.client) {
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
    this.checkpointRequestId += 1;
    this.sessionReloadQueued = false;
    this.loading = false;
    this.checkpointLoadingKey = null;
    this.checkpointBusyKey = null;
    this.sessionMutationPending = false;
    this.sessionMenu = null;
    this.sessionMenuTrigger = null;
  }

  private resetProviderState() {
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

  private captureRequestScope(): SessionsPageRequestScope | null {
    const context = this.context;
    if (!this.isConnected || !context) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (!gateway.snapshot.connected || !client) {
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
      gateway.snapshot.connected &&
      gateway.snapshot.client === scope.client
    );
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
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (data.gateway !== gateway || data.gatewaySnapshot !== snapshot) {
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
        gateway?.connected &&
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
      this.result = result ? filterSessionRows(result, { showArchived: this.showArchived }) : null;
      this.ensureAgentIdentities(this.result);
      const checkpointKey = this.reconcileCheckpointCache(previous, this.result);
      if (checkpointKey) {
        void this.loadCheckpoint(checkpointKey);
      }
    } catch (error) {
      if (requestId === this.sessionRequestId && this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (requestId === this.sessionRequestId && this.isRequestScopeCurrent(scope)) {
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
    const keys = [...this.selectedKeys];
    if (keys.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    if (
      !window.confirm(
        `Delete ${keys.length} ${keys.length === 1 ? "session" : "sessions"}?\n\nThis will delete the session entries and archive their transcripts.`,
      )
    ) {
      return;
    }
    await this.deleteSessions(keys);
  }

  private async deleteSessions(keys: string[]) {
    if (keys.length === 0 || this.loading || this.sessionMutationPending) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    this.sessionMutationPending = true;
    try {
      const result = await scope.sessions.deleteMany(
        keys.map((key) => ({
          key,
          agentId: this.sessionAgentId(key, scope.context),
        })),
      );
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
          scope.gateway.setSessionKey(
            buildAgentMainSessionKey({
              agentId:
                parseAgentSessionKey(deletedCurrent)?.agentId ??
                scope.context.agentSelection.state.selectedId ??
                "main",
              mainKey: resolveUiConfiguredMainKey({
                agentsList: scope.context.agents.state.agentsList,
                hello: scope.gateway.snapshot.hello,
              }),
            }),
          );
        }
      }
      if (result.errors.length > 0) {
        this.error = result.errors.join("; ");
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope)) {
        this.sessionMutationPending = false;
      }
    }
  }

  private async deleteSessionFromMenu(row: GatewaySessionRow) {
    const label = normalizeOptionalString(row.label) ?? row.key;
    if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: label }))) {
      return;
    }
    await this.deleteSessions([row.key]);
  }

  private customGroups(): readonly string[] {
    return this.context?.sessions.state.groups ?? [];
  }

  private knownCategories(): string[] {
    const fromRows = (this.result?.sessions ?? [])
      .map((row) => row.category?.trim())
      .filter((name): name is string => Boolean(name));
    return [
      ...new Set([...this.customGroups(), ...fromRows.toSorted((a, b) => a.localeCompare(b))]),
    ];
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
    const known = this.knownCategories();
    if (!known.includes(name)) {
      void this.context?.sessions.groupsPut([...this.customGroups(), name]);
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

  private renameSession(row: GatewaySessionRow) {
    const value = window.prompt(
      t("sessionsView.renameSessionPrompt"),
      normalizeOptionalString(row.label) ?? "",
    );
    if (value === null) {
      return;
    }
    void this.patchSession(row.key, { label: normalizeOptionalString(value) ?? null });
  }

  private async patchSession(key: string, patch: Parameters<SessionsProps["onPatch"]>[1]) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    try {
      const patched = await scope.sessions.patch(key, patch, {
        agentId: this.sessionAgentId(key, scope.context),
      });
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      if (!patched) {
        this.error = scope.sessions.state.error;
        return;
      }
      const selectedKeys = new Set(this.selectedKeys);
      selectedKeys.delete(key);
      this.selectedKeys = selectedKeys;
      if (
        patch.archived === true &&
        areUiSessionKeysEquivalent(key, scope.gateway.snapshot.sessionKey)
      ) {
        scope.gateway.setSessionKey(
          buildAgentMainSessionKey({
            agentId:
              parseAgentSessionKey(key)?.agentId ??
              scope.context.agentSelection.state.selectedId ??
              "main",
            mainKey: resolveUiConfiguredMainKey({
              agentsList: scope.context.agents.state.agentsList,
              hello: scope.gateway.snapshot.hello,
            }),
          }),
        );
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
      }
    }
  }

  private async forkSession(key: string) {
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const agentId = this.sessionAgentId(key, scope.context);
    try {
      const forkedKey = await scope.sessions.create({
        parentSessionKey: key,
        fork: true,
        ...(agentId ? { agentId } : {}),
      });
      if (!this.isRequestScopeCurrent(scope)) {
        return;
      }
      if (forkedKey) {
        scope.context.navigate("chat", { search: searchForSession(forkedKey), hash: "" });
      } else if (scope.sessions.state.error) {
        this.error = scope.sessions.state.error;
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
      }
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
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    const requestId = ++this.checkpointRequestId;
    this.checkpointLoadingKey = sessionKey;
    this.checkpointErrorByKey = { ...this.checkpointErrorByKey, [sessionKey]: "" };
    try {
      const checkpoints = await scope.sessions.listCheckpoints(sessionKey, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
      if (requestId !== this.checkpointRequestId || !this.isRequestScopeCurrent(scope)) {
        return;
      }
      this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: checkpoints };
    } catch (error) {
      if (requestId !== this.checkpointRequestId || !this.isRequestScopeCurrent(scope)) {
        return;
      }
      this.checkpointErrorByKey = {
        ...this.checkpointErrorByKey,
        [sessionKey]: String(error),
      };
    } finally {
      if (
        requestId === this.checkpointRequestId &&
        this.isRequestScopeCurrent(scope) &&
        this.checkpointLoadingKey === sessionKey
      ) {
        this.checkpointLoadingKey = null;
      }
    }
  }

  private async branchCheckpoint(sessionKey: string, checkpointId: string) {
    if (!window.confirm("Create a new child session from this compacted checkpoint?")) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      const result = await scope.sessions.branchCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
      if (this.isRequestScopeCurrent(scope)) {
        scope.context.navigate("chat", { search: searchForSession(result.key), hash: "" });
      }
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isRequestScopeCurrent(scope) && this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  private async restoreCheckpoint(sessionKey: string, checkpointId: string) {
    if (
      !window.confirm(
        "Restore this session to the selected compacted checkpoint?\n\nThis replaces the current active transcript for the session key.",
      )
    ) {
      return;
    }
    const scope = this.captureRequestScope();
    if (!scope) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      await scope.sessions.restoreCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey, scope.context),
      });
    } catch (error) {
      if (this.isRequestScopeCurrent(scope)) {
        this.error = String(error);
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
      this.sessionMenu = null;
      this.sessionMenuTrigger = null;
      return;
    }
    this.sessionMenu = { key: row.key, ...position };
    this.sessionMenuTrigger = trigger;
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
        .flatMap((card) => [card.sessionKey, card.execution?.sessionKey])
        .filter((key): key is string => typeof key === "string" && key.length > 0),
    );
    const archiveAllowed = canArchiveSessionRow(
      row,
      resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: gateway.hello,
      }),
    );
    return html`
      <openclaw-session-menu
        .session=${{
          key: row.key,
          label: normalizeOptionalString(row.label) ?? row.key,
          pinned: row.pinned === true,
          unread: row.unread === true,
          archived: row.archived === true,
          category: normalizeOptionalString(row.category) ?? null,
        }}
        .x=${menu.x}
        .y=${menu.y}
        .trigger=${this.sessionMenuTrigger}
        .disabled=${this.loading}
        .forkDisabled=${false}
        .archiveAllowed=${archiveAllowed}
        .groups=${this.knownCategories()}
        .canOpenChat=${row.kind !== "global"}
        .workboard=${canCapture && row.kind !== "global"
          ? {
              captured: capturedSessionKeys.has(row.key),
              busy: [...workboardState.capturingSessionKeys][0] === row.key,
            }
          : null}
        .onClose=${() => {
          this.sessionMenu = null;
          this.sessionMenuTrigger = null;
        }}
        .onAction=${(action: SessionMenuAction) => {
          switch (action.kind) {
            case "open-chat":
              context.navigate("chat", { search: searchForSession(row.key), hash: "" });
              break;
            case "toggle-pin":
              void this.patchSession(row.key, { pinned: row.pinned !== true });
              break;
            case "toggle-unread":
              void this.patchSession(row.key, { unread: row.unread !== true });
              break;
            case "rename":
              this.renameSession(row);
              break;
            case "fork":
              void this.forkSession(row.key);
              break;
            case "workboard":
              void this.addToWorkboard(row);
              break;
            case "move-to-group":
              this.assignCategory(row.key, action.category);
              break;
            case "new-group":
              this.requestNewCategory(row.key);
              break;
            case "toggle-archived":
              void this.patchSession(row.key, { archived: row.archived !== true });
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
        sessionMenu: this.sessionMenu,
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
        onOpenSessionMenu: (row, position, trigger) => this.openSessionMenu(row, position, trigger),
        onToggleDetails: (sessionKey) => void this.toggleSessionDetails(sessionKey),
        onBranchFromCheckpoint: (sessionKey, checkpointId) =>
          void this.branchCheckpoint(sessionKey, checkpointId),
        onRestoreCheckpoint: (sessionKey, checkpointId) =>
          void this.restoreCheckpoint(sessionKey, checkpointId),
      })}
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
        this.error = String(error);
      }
    }
  }
}

if (!customElements.get("openclaw-sessions-page")) {
  customElements.define("openclaw-sessions-page", SessionsPage);
}
