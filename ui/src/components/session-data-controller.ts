import type { ReactiveController } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  deriveApprovalBadgeSnapshot,
  type ApprovalBadgeSnapshot,
} from "../app/approval-presentation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { preserveRosterPresentationMetadata } from "../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  collectKnownSessionRows,
  evictArchivedSessionLineage,
  fetchChildSessionRows,
  fetchSessionLineage,
  preserveActiveSessionLineageRows,
  publishActiveSessionLineage,
} from "./app-sidebar-child-session-data.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import { bindAdoptedCatalogSession } from "./app-sidebar-session-catalogs.ts";
import type {
  SidebarSessionMutationScope,
  SidebarSessionsScrollState,
} from "./app-sidebar-session-types.ts";
import { createPanelRefreshStatus, type PanelRefreshStatus } from "./panel-refresh-status.ts";
import {
  applySessionCatalogHostEvent as applySessionCatalogHostEventToData,
  applySessionCatalogPresence as applySessionCatalogPresenceToData,
  loadMoreSessionCatalog as loadMoreSessionCatalogData,
  refreshSessionCatalogs as refreshSessionCatalogData,
  resolveSessionCatalogAgentId,
  scheduleSessionCatalogRefresh,
  type SessionCatalogDataOwner,
  type SessionDataControllerHost,
  updateSessionCatalogData as updateSessionCatalogDataForHost,
} from "./session-data-controller-catalog.ts";
import {
  hasSidebarListFilter,
  publishSidebarSessionError,
  publishSidebarSessionList,
  refreshSidebarSessionList,
  sidebarSessionListQuery,
  subscribeSidebarAgentSessionCaches,
  subscribeFilteredSidebarSessions,
  subscribeSessionDataGatewayEvents,
} from "./session-data-controller-events.ts";
import { SessionDataScrollController } from "./session-data-scroll-controller.ts";

/** Gateway-backed session-list and external-catalog data ownership. */
export class SessionDataController implements ReactiveController, SessionCatalogDataOwner {
  sessionCatalogs: SessionCatalog[] = [];
  sessionCatalogRefreshStatus: PanelRefreshStatus = createPanelRefreshStatus();
  loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  visibleSessionLimits = new Map<string, number>();
  sessionsResult: SessionsListResult | null = null;
  sessionsAgentId: string | null = null;
  sessionsLoading = false;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>> = {};
  loadedChildSessionKeys: ReadonlySet<string> = new Set();
  childSessionErrorsByParent: ReadonlyMap<string, string> = new Map();
  loadingChildSessionKeys: ReadonlySet<string> = new Set();
  activeSessionLineageRoot: GatewaySessionRow | null = null;
  activeSessionLineageSelectedRow: GatewaySessionRow | null = null;
  sessionMutationError: string | null = null;
  presencePayload: PresencePayload | undefined;
  presenceInstanceId?: string;

  // These caches were not Lit state on the element and stay non-reactive here.
  sessionResultsByAgent: Record<string, SessionsListResult> = {};

  private readonly subscriptions: SubscriptionsController;
  readonly sessionCatalogLive = new SessionCatalogLiveState();
  sessionScopeGeneration = 0;
  sessionCatalogAgentId: string | null = null;
  sessionCatalogRevision = 0;
  readonly sessionCatalogPageDepths = new Map<string, number>();
  readonly sessionCatalogRevisions = new Map<string, number>();
  private sessionScopeAgentId: string | null = null;
  private sessionsSource: SessionCapability | null = null;
  private filteredSessionScope: string | null = null;
  private unsubscribeFilteredSessions: (() => void) | null = null;
  private childSessionGeneration = 0;
  private childSessionCanonicalListRevision: number | null = null;
  private activeSessionLineageRouteKey: string | null = null;
  private activeSessionLineageLoaded = false;
  private activeSessionLineageRequest: { readonly sourceRevision: number } | null = null;
  private activeSessionLineageRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayConnectionRevision = 0;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  // Bind mutation completions to one epoch so stale failures cannot cross reconnects.
  private sessionMutationEpoch = 0;
  // Owns the abort signal handed to every epoch-scoped destructive confirm dialog.
  // Retiring the epoch aborts it so a dialog open across a reconnect dismisses
  // itself instead of confirming into a mutation scope that no longer applies.
  private sessionMutationAbortController = new AbortController();
  private readonly scroll = new SessionDataScrollController(() => this.notify());
  private approvalBadgeQueue: ApplicationContext<RouteId>["overlays"]["snapshot"]["approvalQueue"] =
    [];
  private approvalBadges: ApprovalBadgeSnapshot = deriveApprovalBadgeSnapshot([]);

  constructor(private readonly host: SessionDataControllerHost) {
    host.addController(this);
    // The element used to enter subscriptions before connecting catalog listeners,
    // then tear subscriptions down after all session cleanup. Keep that ordering.
    this.subscriptions = new SubscriptionsController({
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => host.requestUpdate(),
      get updateComplete() {
        return host.updateComplete;
      },
    });
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.synchronizeSessions(sessions),
      )
      .effect(
        () => this.context?.sessions,
        (sessions) => sessions.subscribeCreated((key) => host.promoteCreatedSession(key)),
      )
      .effect(
        () => this.context?.gateway,
        (gateway) => subscribeSessionDataGatewayEvents(gateway, this),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => subscribeSidebarAgentSessionCaches(agents, this, notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
        () => this.synchronizeSessionScope(),
      )
      .watch(
        () => this.context?.overlays,
        (overlays, notify) => overlays.subscribe(notify),
      );
  }

  get context(): ApplicationContext<RouteId> | undefined {
    return this.host.sessionDataContext;
  }

  get isSessionDataHostConnected(): boolean {
    return this.host.isConnected;
  }

  get sessionDataHostConnected(): boolean {
    return this.host.connected;
  }

  expandedAgentId(): string {
    return this.host.expandedAgentId();
  }

  requestSessionDataUpdate(): void {
    this.host.requestUpdate();
  }

  sessionListQuery = (agentId: string) => sidebarSessionListQuery(this.host, agentId);

  private readonly notify = () => this.requestSessionDataUpdate();

  hostConnected(): void {
    this.subscriptions.hostConnected();
    this.connectSessionCatalogListeners();
  }

  hostUpdate(): void {
    this.subscriptions.hostUpdate();
  }

  hostUpdated(): void {
    this.synchronizeSessionScope();
    this.scroll.synchronize(this.host);
    this.updateSessionCatalogData(true);
  }

  hostDisconnected(): void {
    this.retireFilteredSessions();
    this.disconnectSessionCatalogListeners();
    this.host.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.retireSessionCatalogData();
    this.scroll.dispose();
    this.clearActiveSessionLineageRetry();
    this.subscriptions.hostDisconnected();
  }

  approvalBadgeSnapshot(): ApprovalBadgeSnapshot {
    const queue = this.context?.overlays?.snapshot.approvalQueue ?? [];
    if (queue !== this.approvalBadgeQueue) {
      this.approvalBadgeQueue = queue;
      this.approvalBadges = deriveApprovalBadgeSnapshot(queue);
    }
    return this.approvalBadges;
  }

  sessionCatalogGatewayClient(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  connectSessionCatalogListeners(): void {
    // The chat pane announces catalog adoptions so the catalog row binds to
    // the new session key before the next catalog poll.
    document.addEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.addEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.addEventListener("focus", this.handleSessionCatalogPageActivation);
  }

  disconnectSessionCatalogListeners(): void {
    document.removeEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.removeEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.removeEventListener("focus", this.handleSessionCatalogPageActivation);
  }

  retireSessionCatalogData(resetConnection = false): void {
    this.sessionScopeGeneration += 1;
    this.sessionsLoading = false;
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogLive.retireConnection(resetConnection);
  }

  resetSessionCatalogConnection(): void {
    this.retireSessionCatalogData();
    this.sessionCatalogRevision += 1;
    this.sessionCatalogLive.resetConnection();
    this.sessionCatalogs = [];
    this.sessionCatalogRefreshStatus = createPanelRefreshStatus();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
    this.notify();
  }

  synchronizeSessionScope(): void {
    const context = this.context;
    const nextAgentId = context ? normalizeAgentId(this.host.expandedAgentId()) : null;
    // A reconnect cannot revoke ownership until its replacement hello is authoritative.
    const nextCatalogAgentId =
      resolveSessionCatalogAgentId(this) ??
      (context?.gateway.snapshot.phase !== "connected" ? this.sessionCatalogAgentId : null);
    if (
      nextAgentId === this.sessionScopeAgentId &&
      nextCatalogAgentId === this.sessionCatalogAgentId
    ) {
      return;
    }

    const previousAgentId = this.sessionScopeAgentId;
    const previousCatalogAgentId = this.sessionCatalogAgentId;
    const agentChanged = previousAgentId !== null && previousAgentId !== nextAgentId;
    const catalogAgentChanged =
      previousCatalogAgentId !== null && previousCatalogAgentId !== nextCatalogAgentId;
    const currentCanonicalAgentId = this.sessionsAgentId;
    const ownsCurrentCanonicalList =
      !hasSidebarListFilter(this.host) &&
      nextAgentId !== null &&
      currentCanonicalAgentId !== null &&
      normalizeAgentId(currentCanonicalAgentId) === nextAgentId &&
      this.sessionsResult === context?.sessions.state.result;

    this.sessionScopeAgentId = nextAgentId;
    this.sessionCatalogAgentId = nextCatalogAgentId;
    this.retireSessionCatalogData();
    this.sessionCatalogRevision += 1;
    this.sessionCatalogRefreshStatus = createPanelRefreshStatus();

    if (agentChanged || catalogAgentChanged) {
      // Catalog cursors and rows belong to the selected agent, not just its host.
      this.sessionCatalogs = [];
      this.sessionCatalogPageDepths.clear();
      this.sessionCatalogRevisions.clear();
    }
    if (agentChanged && !ownsCurrentCanonicalList) {
      // A replacement capability may publish its new-agent list before selection synchronizes.
      this.clearSessionCache();
    }
    this.bindFilteredSessions(nextAgentId ?? "");
    this.notify();

    if (
      agentChanged &&
      context?.gateway.snapshot.phase === "connected" &&
      hasSidebarListFilter(this.host)
    ) {
      void this.refreshSidebarSessions();
    }
  }

  updateSessionCatalogData(defer = false): void {
    updateSessionCatalogDataForHost(this, defer);
  }

  handleSessionCatalogHostEvent(payload: unknown): void {
    applySessionCatalogHostEventToData(this, payload);
  }

  handleSessionCatalogPresence(payload: unknown): void {
    applySessionCatalogPresenceToData(this, payload);
  }

  private readonly handleCatalogSessionContinued = (
    event: CustomEvent<CatalogSessionContinuedDetail>,
  ) => {
    const detail = event.detail;
    const rawAgentId = typeof detail?.agentId === "string" ? detail.agentId.trim() : "";
    const eventAgentId = rawAgentId ? normalizeAgentId(rawAgentId) : null;
    const currentAgentId = this.sessionCatalogAgentId
      ? normalizeAgentId(this.sessionCatalogAgentId)
      : null;
    if (!detail?.sessionKey || !eventAgentId || eventAgentId !== currentAgentId) {
      return;
    }
    this.sessionCatalogs = bindAdoptedCatalogSession(this.sessionCatalogs, detail);
    this.notify();
    // Invalidate in-flight polls and load-more merges so a pre-adoption
    // snapshot cannot clobber the patched rows; the 30s poll reconfirms.
    this.sessionCatalogRevision += 1;
    this.sessionCatalogRevisions.set(
      detail.catalogId,
      (this.sessionCatalogRevisions.get(detail.catalogId) ?? 0) + 1,
    );
  };

  private readonly handleSessionCatalogPageActivation = (event: Event) => {
    scheduleSessionCatalogRefresh(this, event.type === "visibilitychange");
  };

  refreshSessionCatalogs(): Promise<void> {
    return refreshSessionCatalogData(this);
  }

  loadMoreSessionCatalog(catalogId: string): Promise<void> {
    return loadMoreSessionCatalogData(this, catalogId);
  }

  get sessionsScrollState(): SidebarSessionsScrollState {
    return this.scroll.state;
  }

  private clearActiveSessionLineageRetry(): void {
    if (this.activeSessionLineageRetryTimer) {
      globalThis.clearTimeout(this.activeSessionLineageRetryTimer);
      this.activeSessionLineageRetryTimer = null;
    }
  }

  updateSessionsScrollState(element: HTMLElement): void {
    this.scroll.update(element);
  }

  private resetChildSessionState(preserveOperatorContext = false): void {
    this.childSessionGeneration += 1;
    this.childSessionRowsByParent = preserveOperatorContext
      ? preserveActiveSessionLineageRows(
          this.activeSessionLineageRouteKey,
          this.childSessionRowsByParent,
        )
      : {};
    this.loadedChildSessionKeys = new Set();
    this.loadingChildSessionKeys = new Set();
    if (!preserveOperatorContext) {
      this.childSessionErrorsByParent = new Map();
      this.activeSessionLineageRoot = null;
      this.activeSessionLineageSelectedRow = null;
      this.activeSessionLineageRouteKey = null;
    }
    this.activeSessionLineageLoaded = false;
    this.activeSessionLineageRequest = null;
    this.clearActiveSessionLineageRetry();
  }

  private readonly updateSessions = (sessions: SessionCapability) => {
    if (this.childSessionCanonicalListRevision !== sessions.canonicalListRevision) {
      this.childSessionCanonicalListRevision = sessions.canonicalListRevision;
      const routeKey = this.activeSessionLineageRouteKey;
      if (routeKey) {
        const previous =
          this.activeSessionLineageSelectedRow ??
          this.sessionsResult?.sessions.find((row) =>
            areUiSessionKeysEquivalent(row.key, routeKey),
          );
        const canonical = sessions.state.result?.sessions.find((row) =>
          areUiSessionKeysEquivalent(row.key, routeKey),
        );
        // A missing archived route retains its title; canonical rows always own live state.
        this.activeSessionLineageSelectedRow = canonical
          ? preserveRosterPresentationMetadata(canonical, previous)
          : (previous ?? null);
      }
      // Canonical root changes invalidate successful child snapshots, not operator-owned failures.
      // Expanded parents refetch only when no failure blocks them.
      this.resetChildSessionState(true);
      this.notify();
    }
    const snapshot = sessions.state;
    if (hasSidebarListFilter(this.host)) {
      return;
    }
    const gateway = this.context?.gateway;
    const sameGatewayDisconnected =
      gateway !== undefined &&
      gateway === this.gatewaySource &&
      gateway.snapshot.client !== null &&
      gateway.snapshot.phase !== "connected";
    if (sameGatewayDisconnected && this.reconnectListRevision === null) {
      this.reconnectListRevision = sessions.canonicalListRevision + 1;
    }
    const waitingForReconnectList =
      this.reconnectListRevision !== null &&
      sessions.canonicalListRevision < this.reconnectListRevision;
    if (!sameGatewayDisconnected && !waitingForReconnectList) {
      // Keep the result and agent scope paired until the first canonical list
      // after reconnect; chat startup may publish a partial reconciliation first.
      this.reconnectListRevision = null;
      publishSidebarSessionList(this, snapshot);
    }
    this.sessionsLoading = snapshot.loading;
    this.notify();
  };

  private synchronizeSessions(sessions: SessionCapability): void {
    const sourceChanged = sessions !== this.sessionsSource;
    if (sourceChanged) {
      this.invalidateSessionMutations();
      this.retireFilteredSessions();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.phase === "connected") {
      // Group catalog hydration is idempotent per connection.
      void sessions.groupsLoad();
      if (sourceChanged && hasSidebarListFilter(this.host)) {
        void this.refreshSidebarSessions();
      }
    }
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]): void {
    const client = gateway.snapshot.client;
    const connected = gateway.snapshot.phase === "connected";
    const sessionSourceChanged =
      gateway !== this.gatewaySource ||
      gateway.connectionRevision !== this.gatewayConnectionRevision;
    const clientChanged = client !== this.gatewayClient;
    const connectedStarted = connected && !this.gatewayConnected;
    const sourceOrClientChanged = sessionSourceChanged || clientChanged;
    const connectionChanged = connected !== this.gatewayConnected;
    // Presence and auth snapshots must not retire this client's in-flight
    // native or catalog pages unless its connection phase actually changes.
    if (!sourceOrClientChanged && !connectionChanged) {
      return;
    }
    this.invalidateSessionMutations();
    this.gatewaySource = gateway;
    this.gatewayConnectionRevision = gateway.connectionRevision;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    this.presenceInstanceId = client?.instanceId;
    if (!connected) {
      this.presencePayload = undefined;
    } else if (clientChanged || connectedStarted) {
      const presence = readPresenceEntries(gateway.snapshot.hello?.snapshot);
      this.presencePayload = presence ? { presence } : undefined;
    }
    this.notify();
    if (!sourceOrClientChanged) {
      this.retireSessionCatalogData(!connected);
      if (connected && this.sessionsSource && hasSidebarListFilter(this.host)) {
        void this.refreshSidebarSessions();
      }
      return;
    }
    // Session rows belong to the logical Gateway, not one replaceable socket client.
    if (sessionSourceChanged) {
      this.clearSessionCache();
    }
    this.resetSessionCatalogConnection();
    if (connected && this.sessionsSource && hasSidebarListFilter(this.host)) {
      void this.refreshSidebarSessions();
    }
  }

  private clearSessionCache(): void {
    this.childSessionCanonicalListRevision = null;
    this.reconnectListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionResultsByAgent = {};
    this.resetChildSessionState();
    this.visibleSessionLimits.clear();
    this.notify();
  }

  private retireFilteredSessions(): void {
    this.unsubscribeFilteredSessions?.();
    this.unsubscribeFilteredSessions = null;
    this.filteredSessionScope = null;
  }

  private bindFilteredSessions(agentId: string): void {
    const sessions = this.context?.sessions;
    if (!sessions || !hasSidebarListFilter(this.host)) {
      this.retireFilteredSessions();
      return;
    }
    const normalizedAgentId = normalizeAgentId(agentId);
    const query = this.sessionListQuery(normalizedAgentId);
    const scopeKey = JSON.stringify(query);
    if (this.filteredSessionScope === scopeKey) {
      return;
    }
    this.retireFilteredSessions();
    this.filteredSessionScope = scopeKey;
    this.unsubscribeFilteredSessions = subscribeFilteredSidebarSessions(
      this,
      sessions,
      query,
      () =>
        this.filteredSessionScope === scopeKey &&
        this.context?.sessions === sessions &&
        this.host.sidebarSessionStatusFilter() === query.archivedFilter &&
        normalizeAgentId(this.host.expandedAgentId()) === normalizedAgentId,
    );
  }

  refreshSidebarSessions(agentId = this.host.expandedAgentId()): Promise<void> {
    this.bindFilteredSessions(agentId);
    return refreshSidebarSessionList(this, agentId);
  }

  loadMoreSidebarSessions(): Promise<void> {
    return refreshSidebarSessionList(this, this.sessionsAgentId, true);
  }

  async loadChildSessions(parentKey: string): Promise<void> {
    if (
      !parentKey ||
      this.loadedChildSessionKeys.has(parentKey) ||
      this.childSessionErrorsByParent.has(parentKey) ||
      this.loadingChildSessionKeys.has(parentKey)
    ) {
      return;
    }
    const sessions = this.context?.sessions;
    if (!sessions) {
      return;
    }
    const generation = this.childSessionGeneration;
    this.loadingChildSessionKeys = new Set([...this.loadingChildSessionKeys, parentKey]);
    this.notify();
    try {
      const isCurrent = () =>
        generation === this.childSessionGeneration && sessions === this.context?.sessions;
      const rows = await fetchChildSessionRows({ sessions, parentKey, isCurrent });
      if (!rows || !isCurrent()) {
        return;
      }
      for (const existing of this.childSessionRowsByParent[parentKey] ?? []) {
        if (!rows.some((row) => row.key === existing.key)) {
          rows.push(existing);
        }
      }
      this.childSessionRowsByParent = { ...this.childSessionRowsByParent, [parentKey]: rows };
      this.loadedChildSessionKeys = new Set([...this.loadedChildSessionKeys, parentKey]);
    } catch (error) {
      if (generation !== this.childSessionGeneration || sessions !== this.context?.sessions) {
        return;
      }
      // Stop the expanded-row update loop until the operator chooses Retry or collapse/reopen.
      this.childSessionRowsByParent = {
        ...this.childSessionRowsByParent,
        [parentKey]: this.childSessionRowsByParent[parentKey] ?? [],
      };
      this.childSessionErrorsByParent = new Map(this.childSessionErrorsByParent).set(
        parentKey,
        formatUiError(error),
      );
      this.notify();
    } finally {
      if (generation === this.childSessionGeneration && sessions === this.context?.sessions) {
        const next = new Set(this.loadingChildSessionKeys);
        next.delete(parentKey);
        this.loadingChildSessionKeys = next;
        this.notify();
      }
    }
  }

  async loadActiveSessionLineage(sessionKey: string): Promise<void> {
    const normalizedKey = sessionKey.trim();
    if (
      !this.activeSessionLineageRouteKey ||
      !areUiSessionKeysEquivalent(normalizedKey, this.activeSessionLineageRouteKey)
    ) {
      evictArchivedSessionLineage(this, this.activeSessionLineageRouteKey);
      this.activeSessionLineageRouteKey = normalizedKey;
      this.activeSessionLineageLoaded = false;
      this.activeSessionLineageRequest = null;
      this.activeSessionLineageRoot = null;
      this.activeSessionLineageSelectedRow = null;
      this.clearActiveSessionLineageRetry();
      this.notify();
    }
    const { gateway, sessions } = this.context ?? {};
    const client = gateway?.snapshot.client;
    if (
      !normalizedKey ||
      this.activeSessionLineageLoaded ||
      this.activeSessionLineageRequest !== null ||
      this.activeSessionLineageRetryTimer !== null ||
      gateway?.snapshot.phase !== "connected" ||
      !sessions ||
      typeof client?.request !== "function"
    ) {
      return;
    }

    const generation = this.childSessionGeneration;
    const request = { sourceRevision: sessions.canonicalListRevision };
    this.activeSessionLineageRequest = request;
    const isCurrent = () =>
      generation === this.childSessionGeneration &&
      request === this.activeSessionLineageRequest &&
      gateway === this.context?.gateway &&
      client === gateway.snapshot.client;
    const lineage = await fetchSessionLineage({
      client,
      sessionKey: normalizedKey,
      knownRows: collectKnownSessionRows(
        this.sessionsResult?.sessions ?? [],
        this.childSessionRowsByParent,
      ),
      isCurrent,
    });
    if (!lineage || !isCurrent()) {
      return;
    }
    publishActiveSessionLineage(this, normalizedKey, lineage, request.sourceRevision);
    this.notify();
    this.activeSessionLineageRequest = null;
    if (lineage.lookupFailed) {
      this.activeSessionLineageRetryTimer = globalThis.setTimeout(() => {
        this.activeSessionLineageRetryTimer = null;
        if (this.activeSessionLineageRouteKey === normalizedKey) {
          this.notify();
        }
      }, 5_000);
      return;
    }
    this.activeSessionLineageLoaded = true;
  }

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    this.visibleSessionLimits.set(sectionId, limit);
    this.notify();
  }

  dismissSessionMutationError(): void {
    publishSidebarSessionError(this, null, "action");
    this.notify();
  }

  resetSessionList(): void {
    this.retireFilteredSessions();
    this.sessionsLoading = false;
    this.visibleSessionLimits.clear();
    // A filter transition owns a new child/lineage generation; otherwise a
    // pending request from the retired view can repopulate its cleared rows.
    this.resetChildSessionState();
    this.sessionResultsByAgent = {};
    if (!hasSidebarListFilter(this.host) && this.context) {
      this.sessionsResult = this.context.sessions.state.result;
      this.sessionsAgentId = this.context.sessions.state.agentId;
    } else if (this.context) {
      this.bindFilteredSessions(this.host.expandedAgentId());
    }
    this.notify();
  }

  discardEmptyChildSessionSnapshot(sessionKey: string): void {
    if (this.childSessionRowsByParent[sessionKey]?.length === 0) {
      const childRows = { ...this.childSessionRowsByParent };
      delete childRows[sessionKey];
      this.childSessionRowsByParent = childRows;
      const loadedKeys = new Set(this.loadedChildSessionKeys);
      loadedKeys.delete(sessionKey);
      this.loadedChildSessionKeys = loadedKeys;
      this.notify();
    }
  }

  retryChildSessions(sessionKey: string): void {
    if (this.childSessionErrorsByParent.has(sessionKey)) {
      const errors = new Map(this.childSessionErrorsByParent);
      errors.delete(sessionKey);
      this.childSessionErrorsByParent = errors;
      this.notify();
    }
    void this.loadChildSessions(sessionKey);
  }

  private invalidateSessionMutations(): void {
    this.sessionMutationEpoch += 1;
    publishSidebarSessionError(this, null, "action");
    // Dismiss any confirm dialog still open under the retired epoch before a
    // new one can be issued; otherwise it stays modal until manually closed.
    this.sessionMutationAbortController.abort();
    this.sessionMutationAbortController = new AbortController();
    this.notify();
  }

  beginSessionMutation(): SidebarSessionMutationScope | null {
    const context = this.context;
    if (!context || !this.host.connected) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    publishSidebarSessionError(this, null, "action");
    this.notify();
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.host.selectedAgentIdForSessions(),
      signal: this.sessionMutationAbortController.signal,
    };
  }

  isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.host.connected &&
      this.sessionMutationEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  publishSessionMutationError(scope: SidebarSessionMutationScope, error: unknown): void {
    if (this.isSessionMutationScopeCurrent(scope)) {
      publishSidebarSessionError(this, formatUiError(error), "action");
      this.notify();
    }
  }
}
