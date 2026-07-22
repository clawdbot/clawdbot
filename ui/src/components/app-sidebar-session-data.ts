import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  deriveApprovalBadgeSnapshot,
  type ApprovalBadgeSnapshot,
} from "../app/approval-presentation.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  collectKnownSessionRows,
  fetchChildSessionRows,
  fetchSessionLineage,
  mergeChildSessionRows,
} from "./app-sidebar-child-session-data.ts";
import { AppSidebarSessionCatalogDataElement } from "./app-sidebar-session-catalog-data.ts";
import {
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  SIDEBAR_SESSION_PAGE_SIZE,
  type SidebarSessionMutationScope,
  type SidebarSessionStatusFilter,
  type SidebarSessionsScrollState,
} from "./app-sidebar-session-types.ts";
/** Gateway-backed session and external-catalog synchronization. */
export abstract class AppSidebarSessionDataElement extends AppSidebarSessionCatalogDataElement {
  @state() protected visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
  @state() protected sessionsResult: SessionsListResult | null = null;
  @state() protected sessionsAgentId: string | null = null;
  @state() protected sessionsLoading = false;
  @state() protected childSessionRowsByParent: Readonly<
    Record<string, readonly GatewaySessionRow[]>
  > = {};
  @state() protected loadedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected failedChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected loadingChildSessionKeys: ReadonlySet<string> = new Set();
  @state() protected activeSessionLineageRoot: GatewaySessionRow | null = null;
  @state() protected sessionsScrollState: SidebarSessionsScrollState = "none";
  @state() protected sessionMutationError: string | null = null;
  @state() protected presencePayload: unknown;
  @state() protected presenceInstanceId?: string;

  protected sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  protected sessionCreatedOrder = new Map<string, number>();
  private readonly subscriptions = new SubscriptionsController(this);
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

  abstract dismissTransientMenus(): boolean;
  protected abstract promoteCreatedSession(sessionKey: string): void;
  protected abstract selectedAgentIdForSessions(): string;
  protected abstract sidebarSessionStatusFilter(): SidebarSessionStatusFilter;

  constructor() {
    super();
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
        (sessions) => sessions.subscribeCreated((key) => this.promoteCreatedSession(key)),
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
              this.presencePayload = event.payload;
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

  protected approvalBadgeSnapshot(): ApprovalBadgeSnapshot {
    const queue = this.context?.overlays?.snapshot.approvalQueue ?? [];
    if (queue !== this.approvalBadgeQueue) {
      this.approvalBadgeQueue = queue;
      this.approvalBadges = deriveApprovalBadgeSnapshot(queue);
    }
    return this.approvalBadges;
  }

  protected sessionCatalogGatewayClient(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.connectSessionCatalogListeners();
  }

  override disconnectedCallback() {
    this.disconnectSessionCatalogListeners();
    this.dismissTransientMenus();
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
    super.disconnectedCallback();
  }

  override updated() {
    this.syncSessionsScrollObserver();
    this.updateSessionCatalogData();
  }

  private syncSessionsScrollObserver() {
    const element = this.querySelector<HTMLElement>(".sidebar-shell__body");
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
  private scheduleSessionsScrollStateSync() {
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

  protected updateSessionsScrollState(element: HTMLElement) {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    let nextState: SidebarSessionsScrollState = "none";
    if (maxScrollTop > 1) {
      if (element.scrollTop <= 1) {
        nextState = "top";
      } else if (element.scrollTop >= maxScrollTop - 1) {
        nextState = "bottom";
      } else {
        nextState = "middle";
      }
    }
    if (nextState !== this.sessionsScrollState) {
      this.sessionsScrollState = nextState;
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
    }
    const snapshot = sessions.state;
    if (this.sidebarSessionStatusFilter() !== "active") {
      return;
    }
    const gateway = this.context?.gateway;
    const sameClientDisconnected =
      gateway !== undefined &&
      gateway === this.gatewaySource &&
      gateway.snapshot.client !== null &&
      gateway.snapshot.client === this.gatewayClient &&
      !gateway.snapshot.connected;
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
  };

  private synchronizeSessions(sessions: SessionCapability) {
    if (sessions !== this.sessionsSource) {
      this.invalidateSessionMutations();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.connected) {
      // Group catalog hydration is idempotent per connection.
      void sessions.groupsLoad();
      if (this.sidebarSessionStatusFilter() !== "active") {
        void this.refreshSidebarSessions();
      }
    }
  }

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const client = gateway.snapshot.client;
    const connected = gateway.snapshot.connected;
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
      this.presencePayload = gateway.snapshot.hello?.snapshot;
    }
    if (!sourceOrClientChanged) {
      return;
    }
    this.clearSessionCache();
    this.resetSessionCatalogConnection();
    if (connected && this.sessionsSource && this.sidebarSessionStatusFilter() !== "active") {
      void this.refreshSidebarSessions();
    }
  }

  private clearSessionCache() {
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
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
  }

  protected async refreshSidebarSessions(agentId = this.expandedAgentId()): Promise<void> {
    const sessions = this.context?.sessions;
    if (!sessions) {
      return;
    }
    const archivedFilter = this.sidebarSessionStatusFilter();
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
    try {
      const result = await sessions.list(options);
      if (
        token !== this.sidebarListRequestToken ||
        sessions !== this.context?.sessions ||
        archivedFilter !== this.sidebarSessionStatusFilter()
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
    } catch (error) {
      if (token === this.sidebarListRequestToken) {
        this.sessionMutationError = String(error);
      }
    } finally {
      if (token === this.sidebarListRequestToken) {
        this.sessionsLoading = false;
      }
    }
  }

  protected async loadChildSessions(parentKey: string): Promise<void> {
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
    try {
      const isCurrent = () =>
        generation === this.childSessionGeneration && sessions === this.context?.sessions;
      const rows = await fetchChildSessionRows({
        sessions,
        parentKey,
        isCurrent,
      });
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
    } finally {
      if (generation === this.childSessionGeneration && sessions === this.context?.sessions) {
        const next = new Set(this.loadingChildSessionKeys);
        next.delete(parentKey);
        this.loadingChildSessionKeys = next;
      }
    }
  }

  protected async loadActiveSessionLineage(sessionKey: string): Promise<void> {
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
    }
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (
      !normalizedKey ||
      this.activeSessionLineageLoaded ||
      this.activeSessionLineageRequestToken !== null ||
      this.activeSessionLineageRetryTimer !== null ||
      !gateway?.snapshot.connected ||
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
    this.activeSessionLineageRequestToken = null;
    if (lineage.lookupFailed) {
      this.activeSessionLineageRetryTimer = globalThis.setTimeout(() => {
        this.activeSessionLineageRetryTimer = null;
        if (this.activeSessionLineageRouteKey === normalizedKey) {
          this.requestUpdate();
        }
      }, 5_000);
      return;
    }
    this.activeSessionLineageLoaded = true;
  }

  private invalidateSessionMutations() {
    this.sessionMutationEpoch += 1;
    this.sessionMutationError = null;
  }

  protected beginSessionMutation(): SidebarSessionMutationScope | null {
    const context = this.context;
    if (!context || !this.connected) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (!gateway.snapshot.connected || !client) {
      return null;
    }
    this.sessionMutationError = null;
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.selectedAgentIdForSessions(),
    };
  }

  protected isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.connected &&
      this.sessionMutationEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      gateway.snapshot.connected &&
      gateway.snapshot.client === scope.client
    );
  }

  protected publishSessionMutationError(scope: SidebarSessionMutationScope, error: unknown) {
    if (this.isSessionMutationScopeCurrent(scope)) {
      this.sessionMutationError = String(error);
    }
  }
}
