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
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  collectKnownSessionRows,
  fetchChildSessionRows,
  fetchSessionLineage,
  mergeChildSessionRows,
} from "./app-sidebar-child-session-data.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import { bindAdoptedCatalogSession } from "./app-sidebar-session-catalogs.ts";
import {
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  resolveSidebarSessionsScrollState,
  type SidebarSessionMutationScope,
  type SidebarSessionStatusFilter,
  type SidebarSessionsScrollState,
} from "./app-sidebar-session-types.ts";
import {
  applySessionCatalogHostEvent as applySessionCatalogHostEventToData,
  loadMoreSessionCatalog as loadMoreSessionCatalogData,
  refreshSessionCatalogs as refreshSessionCatalogData,
  requestSessionCatalogRefresh as requestSessionCatalogDataRefresh,
  synchronizeSessionCatalogAgent,
  type SessionCatalogDataOwner,
  type SessionDataControllerHost,
  visibleSessionCatalogClient,
} from "./session-data-controller-catalog.ts";

/** Gateway-backed session-list and external-catalog data ownership. */
export class SessionDataController implements ReactiveController, SessionCatalogDataOwner {
  sessionCatalogs: SessionCatalog[] = [];
  loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  visibleSessionLimits = new Map<string, number>();
  sessionsResult: SessionsListResult | null = null;
  sessionsAgentId: string | null = null;
  sessionsLoading = false;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>> = {};
  loadedChildSessionKeys: ReadonlySet<string> = new Set();
  failedChildSessionKeys: ReadonlySet<string> = new Set();
  loadingChildSessionKeys: ReadonlySet<string> = new Set();
  activeSessionLineageRoot: GatewaySessionRow | null = null;
  sessionsScrollState: SidebarSessionsScrollState = "none";
  sessionMutationError: string | null = null;
  presencePayload: PresencePayload | undefined;
  presenceInstanceId?: string;

  // These caches were not Lit state on the element and stay non-reactive here.
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  sessionCreatedOrder = new Map<string, number>();

  private readonly subscriptions: SubscriptionsController;
  readonly sessionCatalogLive = new SessionCatalogLiveState();
  sessionCatalogAgentId: string | null = null;
  sessionCatalogGeneration = 0;
  sessionCatalogRevision = 0;
  readonly sessionCatalogPageDepths = new Map<string, number>();
  readonly sessionCatalogRevisions = new Map<string, number>();
  private sessionsSource: SessionCapability | null = null;
  private childSessionGeneration = 0;
  private sidebarListRequestToken: symbol | null = null;
  private childSessionCanonicalListRevision: number | null = null;
  private activeSessionLineageRouteKey: string | null = null;
  private activeSessionLineageLoaded = false;
  private activeSessionLineageRequestToken: symbol | null = null;
  private activeSessionLineageRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  // Bind mutation completions to one epoch so stale failures cannot cross reconnects.
  private sessionMutationEpoch = 0;
  private sessionsScrollElement: HTMLElement | null = null;
  private sessionsScrollResizeObserver: ResizeObserver | null = null;
  private sessionsScrollStateFrame: number | null = null;
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
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (event.event === "sessions.catalog.host") {
              this.handleSessionCatalogHostEvent(event.payload);
              return;
            }
            if (event.event === "presence") {
              const presence = readPresenceEntries(event.payload);
              this.presencePayload = presence ? { presence } : undefined;
              this.notify();
              this.handleSessionCatalogPresence(event.payload);
            }
          }),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
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

  private readonly notify = () => this.requestSessionDataUpdate();

  hostConnected(): void {
    this.subscriptions.hostConnected();
    this.connectSessionCatalogListeners();
  }

  hostUpdate(): void {
    this.subscriptions.hostUpdate();
  }

  hostUpdated(): void {
    this.syncSessionsScrollObserver();
    this.updateSessionCatalogData();
  }

  hostDisconnected(): void {
    this.disconnectSessionCatalogListeners();
    this.host.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.retireSessionCatalogData();
    this.sessionsScrollResizeObserver?.disconnect();
    this.sessionsScrollResizeObserver = null;
    this.sessionsScrollElement = null;
    if (this.sessionsScrollStateFrame !== null) {
      cancelAnimationFrame(this.sessionsScrollStateFrame);
      this.sessionsScrollStateFrame = null;
    }
    if (this.activeSessionLineageRetryTimer) {
      globalThis.clearTimeout(this.activeSessionLineageRetryTimer);
      this.activeSessionLineageRetryTimer = null;
    }
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

  retireSessionCatalogData(): void {
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogLive.clear();
  }

  resetSessionCatalogConnection(): void {
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.sessionCatalogLive.resetConnection();
    this.sessionCatalogs = [];
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
    this.notify();
  }

  updateSessionCatalogData(): void {
    if (this.context) {
      synchronizeSessionCatalogAgent(this, this.host.expandedAgentId());
    }
    if (
      !visibleSessionCatalogClient(this) ||
      this.sessionCatalogLive.timer ||
      this.sessionCatalogLive.requestGeneration === this.sessionCatalogGeneration
    ) {
      return;
    }
    void this.refreshSessionCatalogs();
  }

  handleSessionCatalogHostEvent(payload: unknown): void {
    applySessionCatalogHostEventToData(this, payload);
  }

  handleSessionCatalogPresence(payload: unknown): void {
    if (this.sessionCatalogLive.observePresence(payload)) {
      requestSessionCatalogDataRefresh(this);
    }
  }

  private readonly handleCatalogSessionContinued = (
    event: CustomEvent<CatalogSessionContinuedDetail>,
  ) => {
    const detail = event.detail;
    if (!detail?.sessionKey) {
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

  private readonly handleSessionCatalogPageActivation = () => {
    if (document.visibilityState === "hidden") {
      this.sessionCatalogLive.cancelScheduledRefreshes();
      return;
    }
    this.sessionCatalogLive.scheduleActivation(() => requestSessionCatalogDataRefresh(this));
  };

  refreshSessionCatalogs(): Promise<void> {
    return refreshSessionCatalogData(this);
  }

  loadMoreSessionCatalog(catalogId: string): Promise<void> {
    return loadMoreSessionCatalogData(this, catalogId);
  }

  private syncSessionsScrollObserver(): void {
    const element = this.host.querySelector(".sidebar-shell__body") as HTMLElement | null;
    if (element !== this.sessionsScrollElement) {
      this.sessionsScrollResizeObserver?.disconnect();
      this.sessionsScrollElement = element;
      this.sessionsScrollResizeObserver = null;
      if (element && typeof ResizeObserver === "function") {
        this.sessionsScrollResizeObserver = new ResizeObserver(() =>
          this.updateSessionsScrollState(element),
        );
        this.sessionsScrollResizeObserver.observe(element);
      }
    }
    if (element) {
      this.scheduleSessionsScrollStateSync();
    }
  }

  // One rAF-coalesced scroll read rides paint layout instead of flushing every update.
  private scheduleSessionsScrollStateSync(): void {
    if (this.sessionsScrollStateFrame !== null) {
      return;
    }
    this.sessionsScrollStateFrame = requestAnimationFrame(() => {
      this.sessionsScrollStateFrame = null;
      const element = this.sessionsScrollElement;
      if (element?.isConnected) {
        this.updateSessionsScrollState(element);
      }
    });
  }

  updateSessionsScrollState(element: HTMLElement): void {
    const nextState = resolveSidebarSessionsScrollState(element);
    if (nextState !== this.sessionsScrollState) {
      this.sessionsScrollState = nextState;
      this.notify();
    }
  }

  private readonly updateSessions = (sessions: SessionCapability) => {
    if (this.childSessionCanonicalListRevision !== sessions.canonicalListRevision) {
      this.childSessionCanonicalListRevision = sessions.canonicalListRevision;
      // The canonical root list advances after session events, but excludes hidden children.
      // Drop child snapshots so expanded parents refetch live terminal state.
      this.childSessionGeneration += 1;
      this.childSessionRowsByParent = {};
      this.loadedChildSessionKeys = new Set();
      this.failedChildSessionKeys = new Set();
      this.loadingChildSessionKeys = new Set();
      this.activeSessionLineageRoot = null;
      this.activeSessionLineageRouteKey = null;
      this.activeSessionLineageLoaded = false;
      this.activeSessionLineageRequestToken = null;
      if (this.activeSessionLineageRetryTimer) {
        globalThis.clearTimeout(this.activeSessionLineageRetryTimer);
        this.activeSessionLineageRetryTimer = null;
      }
      this.notify();
    }
    const snapshot = sessions.state;
    if (this.host.sidebarSessionStatusFilter() !== "active") {
      return;
    }
    const gateway = this.context?.gateway;
    const sameClientDisconnected =
      gateway !== undefined &&
      gateway === this.gatewaySource &&
      gateway.snapshot.client !== null &&
      gateway.snapshot.client === this.gatewayClient &&
      gateway.snapshot.phase !== "connected";
    if (sameClientDisconnected && this.reconnectListRevision === null) {
      this.reconnectListRevision = sessions.canonicalListRevision + 1;
    }
    const waitingForReconnectList =
      this.reconnectListRevision !== null &&
      sessions.canonicalListRevision < this.reconnectListRevision;
    if (!sameClientDisconnected && !waitingForReconnectList) {
      // Keep the result and agent scope paired until the first canonical list
      // after reconnect; chat startup may publish a partial reconciliation first.
      this.reconnectListRevision = null;
      this.sessionsResult = snapshot.result;
      this.sessionsAgentId = snapshot.agentId;
      if (snapshot.result) {
        for (const row of snapshot.result.sessions) {
          if (row.key && !this.sessionCreatedOrder.has(row.key)) {
            this.sessionCreatedOrder.set(row.key, this.sessionCreatedOrder.size);
          }
        }
      }
      if (snapshot.result && snapshot.agentId) {
        this.sessionRowsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result.sessions;
      }
    }
    this.sessionsLoading = snapshot.loading;
    this.notify();
  };

  private synchronizeSessions(sessions: SessionCapability): void {
    if (sessions !== this.sessionsSource) {
      this.invalidateSessionMutations();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.phase === "connected") {
      // Group catalog hydration is idempotent per connection.
      void sessions.groupsLoad();
      if (this.host.sidebarSessionStatusFilter() !== "active") {
        void this.refreshSidebarSessions();
      }
    }
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]): void {
    const client = gateway.snapshot.client;
    const connected = gateway.snapshot.phase === "connected";
    const clientChanged = client !== this.gatewayClient;
    const connectedStarted = connected && !this.gatewayConnected;
    const sourceOrClientChanged = gateway !== this.gatewaySource || client !== this.gatewayClient;
    const connectionChanged = connected !== this.gatewayConnected;
    if (!sourceOrClientChanged && !connectionChanged) {
      return;
    }
    this.invalidateSessionMutations();
    this.gatewaySource = gateway;
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
      return;
    }
    this.clearSessionCache();
    this.resetSessionCatalogConnection();
    if (connected && this.sessionsSource && this.host.sidebarSessionStatusFilter() !== "active") {
      void this.refreshSidebarSessions();
    }
  }

  private clearSessionCache(): void {
    this.sidebarListRequestToken = null;
    this.childSessionGeneration += 1;
    this.childSessionCanonicalListRevision = null;
    this.reconnectListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionRowsByAgent = {};
    this.childSessionRowsByParent = {};
    this.loadedChildSessionKeys = new Set();
    this.failedChildSessionKeys = new Set();
    this.loadingChildSessionKeys = new Set();
    this.activeSessionLineageRoot = null;
    this.activeSessionLineageRouteKey = null;
    this.activeSessionLineageLoaded = false;
    this.activeSessionLineageRequestToken = null;
    if (this.activeSessionLineageRetryTimer) {
      globalThis.clearTimeout(this.activeSessionLineageRetryTimer);
      this.activeSessionLineageRetryTimer = null;
    }
    this.sessionCreatedOrder.clear();
    this.visibleSessionLimits.clear();
    this.notify();
  }

  async refreshSidebarSessions(agentId = this.host.expandedAgentId()): Promise<void> {
    const sessions = this.context?.sessions;
    if (!sessions) {
      return;
    }
    const archivedFilter = this.host.sidebarSessionStatusFilter();
    const options = {
      agentId,
      archivedFilter,
      limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
    } as const;
    if (archivedFilter === "active") {
      // Retire any in-flight archived/all list so its late catch/finally cannot
      // publish a stale mutation error or clear loading during the active refresh.
      this.sidebarListRequestToken = null;
      await sessions.refresh({ ...options, force: true });
      return;
    }
    const token = Symbol(agentId);
    this.sidebarListRequestToken = token;
    this.sessionsLoading = true;
    this.notify();
    try {
      const result = await sessions.list(options);
      if (
        token !== this.sidebarListRequestToken ||
        sessions !== this.context?.sessions ||
        archivedFilter !== this.host.sidebarSessionStatusFilter()
      ) {
        return;
      }
      this.sessionsResult = result;
      this.sessionsAgentId = agentId;
      if (result) {
        this.sessionRowsByAgent[normalizeAgentId(agentId)] = result.sessions;
        for (const row of result.sessions) {
          if (row.key && !this.sessionCreatedOrder.has(row.key)) {
            this.sessionCreatedOrder.set(row.key, this.sessionCreatedOrder.size);
          }
        }
      }
      this.notify();
    } catch (error) {
      if (token === this.sidebarListRequestToken) {
        this.sessionMutationError = String(error);
        this.notify();
      }
    } finally {
      if (token === this.sidebarListRequestToken) {
        this.sessionsLoading = false;
        this.notify();
      }
    }
  }

  async loadChildSessions(parentKey: string): Promise<void> {
    if (
      !parentKey ||
      this.loadedChildSessionKeys.has(parentKey) ||
      this.failedChildSessionKeys.has(parentKey) ||
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
      if (this.failedChildSessionKeys.has(parentKey)) {
        const failedKeys = new Set(this.failedChildSessionKeys);
        failedKeys.delete(parentKey);
        this.failedChildSessionKeys = failedKeys;
      }
      this.notify();
    } catch {
      if (generation !== this.childSessionGeneration || sessions !== this.context?.sessions) {
        return;
      }
      // Stop the expanded-row update loop. A canonical list revision or an
      // explicit collapse/reopen clears the failure and retries the whole page set.
      this.childSessionRowsByParent = {
        ...this.childSessionRowsByParent,
        [parentKey]: this.childSessionRowsByParent[parentKey] ?? [],
      };
      this.failedChildSessionKeys = new Set([...this.failedChildSessionKeys, parentKey]);
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
    if (normalizedKey !== this.activeSessionLineageRouteKey) {
      this.activeSessionLineageRouteKey = normalizedKey;
      this.activeSessionLineageLoaded = false;
      this.activeSessionLineageRequestToken = null;
      this.activeSessionLineageRoot = null;
      if (this.activeSessionLineageRetryTimer) {
        globalThis.clearTimeout(this.activeSessionLineageRetryTimer);
        this.activeSessionLineageRetryTimer = null;
      }
      this.notify();
    }
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (
      !normalizedKey ||
      this.activeSessionLineageLoaded ||
      this.activeSessionLineageRequestToken !== null ||
      this.activeSessionLineageRetryTimer !== null ||
      gateway?.snapshot.phase !== "connected" ||
      !client ||
      typeof client.request !== "function"
    ) {
      return;
    }

    const generation = this.childSessionGeneration;
    const token = Symbol(normalizedKey);
    this.activeSessionLineageRequestToken = token;
    const isCurrent = () =>
      generation === this.childSessionGeneration &&
      token === this.activeSessionLineageRequestToken &&
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
    this.childSessionRowsByParent = mergeChildSessionRows(
      this.childSessionRowsByParent,
      lineage.rowsByParent,
    );
    this.activeSessionLineageRoot = lineage.topmostRow;
    this.notify();
    this.activeSessionLineageRequestToken = null;
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
    this.sessionMutationError = null;
    this.notify();
  }

  resetForStatusFilter(statusFilter: SidebarSessionStatusFilter): void {
    this.visibleSessionLimits.clear();
    this.childSessionRowsByParent = {};
    this.loadedChildSessionKeys = new Set();
    this.failedChildSessionKeys = new Set();
    this.loadingChildSessionKeys = new Set();
    this.sessionRowsByAgent = {};
    if (statusFilter === "active" && this.context) {
      this.sessionsResult = this.context.sessions.state.result;
      this.sessionsAgentId = this.context.sessions.state.agentId;
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
    if (this.failedChildSessionKeys.has(sessionKey)) {
      const failedKeys = new Set(this.failedChildSessionKeys);
      failedKeys.delete(sessionKey);
      this.failedChildSessionKeys = failedKeys;
      this.notify();
    }
    void this.loadChildSessions(sessionKey);
  }

  private invalidateSessionMutations(): void {
    this.sessionMutationEpoch += 1;
    this.sessionMutationError = null;
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
    this.sessionMutationError = null;
    this.notify();
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.host.selectedAgentIdForSessions(),
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
      this.sessionMutationError = String(error);
      this.notify();
    }
  }
}
