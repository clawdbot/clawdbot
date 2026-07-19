import { state } from "lit/decorators.js";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  deriveApprovalBadgeSnapshot,
  type ApprovalBadgeSnapshot,
} from "../app/approval-presentation.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import {
  collectKnownSessionRows,
  fetchChildSessionRows,
  fetchSessionLineage,
  mergeChildSessionRows,
} from "./app-sidebar-child-session-data.ts";
import {
  refreshSessionCatalogsLive,
  SESSION_CATALOG_CHANGED_REFRESH_MS,
  SessionCatalogLiveState,
  sessionCatalogListClient,
} from "./app-sidebar-session-catalog-live.ts";
import {
  mergeSessionCatalogPage,
  sessionCatalogRequestError,
} from "./app-sidebar-session-catalog-state.ts";
import { bindAdoptedCatalogSession } from "./app-sidebar-session-catalogs.ts";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  sessionCatalogHostKey,
  type SidebarSessionMutationScope,
  type SidebarSessionsScrollState,
} from "./app-sidebar-session-types.ts";

/** Gateway-backed session and external-catalog synchronization. */
export abstract class AppSidebarSessionDataElement extends AppSidebarBase {
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
  @state() protected sessionCatalogs: SessionCatalog[] = [];
  @state() protected loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  @state() protected sessionMutationError: string | null = null;
  @state() protected presencePayload: unknown;
  @state() protected presenceInstanceId?: string;

  protected sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  protected sessionCreatedOrder = new Map<string, number>();

  private readonly subscriptions = new SubscriptionsController(this);
  private sessionsSource: SessionCapability | null = null;
  private childSessionGeneration = 0;
  private childSessionCanonicalListRevision: number | null = null;
  private activeSessionLineageRouteKey: string | null = null;
  private activeSessionLineageLoaded = false;
  private activeSessionLineageRequestToken: symbol | null = null;
  private activeSessionLineageRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  // Mutation completions belong to one context/capability/connection epoch.
  // Bumping this prevents old failures or batch tails crossing a reconnect.
  private sessionMutationEpoch = 0;
  private sessionsScrollElement: HTMLElement | null = null;
  private sessionsScrollResizeObserver: ResizeObserver | null = null;
  private sessionsScrollStateFrame: number | null = null;
  private readonly sessionCatalogLive = new SessionCatalogLiveState();
  private sessionCatalogAgentId: string | null = null;
  private sessionCatalogGeneration = 0;
  private sessionCatalogRevision = 0;
  private readonly sessionCatalogPageDepths = new Map<string, number>();
  private readonly sessionCatalogRevisions = new Map<string, number>();
  private approvalBadgeQueue: ApplicationContext<RouteId>["overlays"]["snapshot"]["approvalQueue"] =
    [];
  private approvalBadges: ApprovalBadgeSnapshot = deriveApprovalBadgeSnapshot([]);

  abstract dismissTransientMenus(): boolean;
  protected abstract expandedAgentId(): string;
  protected abstract promoteCreatedSession(sessionKey: string): void;
  protected abstract selectedAgentIdForSessions(): string;

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
              this.applySessionCatalogHostEvent(event.payload);
              return;
            }
            if (event.event === "presence") {
              this.presencePayload = event.payload;
              if (this.sessionCatalogLive.observePresence(event.payload)) {
                this.requestSessionCatalogRefresh();
              }
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

  override connectedCallback() {
    super.connectedCallback();
    // The chat pane announces catalog adoptions so the catalog row binds to
    // the new session key before the next catalog poll.
    document.addEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.addEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.addEventListener("focus", this.handleSessionCatalogPageActivation);
  }

  override disconnectedCallback() {
    document.removeEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.removeEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.removeEventListener("focus", this.handleSessionCatalogPageActivation);
    this.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogLive.clear();
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
    if (this.context) {
      this.synchronizeSessionCatalogAgent(this.expandedAgentId());
    }
    if (
      !this.visibleSessionCatalogClient() ||
      this.sessionCatalogLive.timer ||
      this.sessionCatalogLive.requestGeneration === this.sessionCatalogGeneration
    ) {
      return;
    }
    void this.refreshSessionCatalogs();
  }

  private visibleSessionCatalogClient(): GatewayBrowserClient | null {
    if (document.visibilityState === "hidden") {
      return null;
    }
    return sessionCatalogListClient(this.context?.gateway.snapshot, this.connected);
  }

  private synchronizeSessionCatalogAgent(agentId: string) {
    if (agentId === this.sessionCatalogAgentId) {
      return;
    }
    this.sessionCatalogAgentId = agentId;
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.sessionCatalogLive.clear();
    this.loadingMoreSessionCatalogIds = new Set();
    if (this.sessionCatalogs.some((catalog) => catalog.capabilities.createSession)) {
      this.sessionCatalogs = this.sessionCatalogs.map((catalog) => {
        const { createSession: _createSession, ...capabilities } = catalog.capabilities;
        return { ...catalog, capabilities };
      });
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
    this.sessionCatalogLive.scheduleActivation(() => this.requestSessionCatalogRefresh());
  };

  private requestSessionCatalogRefresh() {
    const snapshot = this.context?.gateway.snapshot;
    this.sessionCatalogLive.requestRefresh({
      visible: document.visibilityState !== "hidden",
      connected: this.isConnected && Boolean(sessionCatalogListClient(snapshot, this.connected)),
      generation: this.sessionCatalogGeneration,
      refresh: () => void this.refreshSessionCatalogs(),
    });
  }

  private applySessionCatalogHostEvent(payload: unknown) {
    const update = this.sessionCatalogLive.applyHost({
      payload,
      agentId: this.sessionCatalogAgentId ?? "",
      catalogs: this.sessionCatalogs,
      pageDepths: this.sessionCatalogPageDepths,
    });
    if (!update) {
      return;
    }
    this.sessionCatalogs = update.catalogs;
    this.sessionCatalogRevision += this.sessionCatalogLive.refetching ? 1 : 0;
    const catalogRevision = this.sessionCatalogRevisions.get(update.catalogId) ?? 0;
    this.sessionCatalogRevisions.set(update.catalogId, catalogRevision + 1);
    if (this.sessionCatalogLive.requestGeneration !== this.sessionCatalogGeneration) {
      this.sessionCatalogLive.schedule(
        SESSION_CATALOG_CHANGED_REFRESH_MS,
        this.isConnected,
        () => void this.refreshSessionCatalogs(),
      );
    }
  }

  private async refreshSessionCatalogs() {
    // Hidden pages resume through the coalesced activation handler. Starting
    // here without a timer makes catalog state updates poll at request latency.
    const client = this.visibleSessionCatalogClient();
    if (!client) {
      return;
    }
    const generation = this.sessionCatalogGeneration;
    const revision = this.sessionCatalogRevision;
    const agentId = this.sessionCatalogAgentId ?? this.expandedAgentId();
    await refreshSessionCatalogsLive({
      live: this.sessionCatalogLive,
      client,
      agentId,
      generation,
      revision,
      currentGeneration: () => this.sessionCatalogGeneration,
      currentRevision: () => this.sessionCatalogRevision,
      currentClient: () => this.gatewayClient,
      catalogs: () => this.sessionCatalogs,
      pageDepths: this.sessionCatalogPageDepths,
      connected: () => this.isConnected,
      applyFinal: (catalogs, revisedCatalogIds) => {
        this.sessionCatalogs = catalogs;
        for (const catalogId of revisedCatalogIds) {
          this.sessionCatalogRevisions.set(
            catalogId,
            (this.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
          );
        }
        this.sessionCatalogRevision += 1;
      },
      refresh: () => void this.refreshSessionCatalogs(),
    });
  }

  protected async loadMoreSessionCatalog(catalogId: string) {
    if (this.loadingMoreSessionCatalogIds.has(catalogId)) {
      return;
    }
    const catalog = this.sessionCatalogs.find((candidate) => candidate.id === catalogId);
    const cursors = Object.fromEntries(
      (catalog?.hosts ?? []).flatMap((host) =>
        host.nextCursor ? [[host.hostId, host.nextCursor] as const] : [],
      ),
    );
    if (!catalog || Object.keys(cursors).length === 0) {
      return;
    }
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.connected) {
      return;
    }
    const generation = this.sessionCatalogGeneration;
    const agentId = this.sessionCatalogAgentId ?? this.expandedAgentId();
    const revision = this.sessionCatalogRevisions.get(catalogId) ?? 0;
    this.loadingMoreSessionCatalogIds = new Set([...this.loadingMoreSessionCatalogIds, catalogId]);
    try {
      const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
        agentId,
        catalogId,
        cursors,
      });
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== (this.sessionCatalogRevisions.get(catalogId) ?? 0) ||
        client !== this.gatewayClient
      ) {
        return;
      }
      const page = result.catalogs.find((candidate) => candidate.id === catalogId);
      if (!page) {
        return;
      }
      const current = this.sessionCatalogs.find((candidate) => candidate.id === catalogId);
      if (!current) {
        return;
      }
      const merged = mergeSessionCatalogPage({ current, page, cursors });
      for (const hostId of merged.advancedHostIds) {
        const key = sessionCatalogHostKey(catalogId, hostId);
        this.sessionCatalogPageDepths.set(key, (this.sessionCatalogPageDepths.get(key) ?? 0) + 1);
      }
      this.sessionCatalogs = this.sessionCatalogs.map((candidate) =>
        candidate.id === catalogId ? merged.catalog : candidate,
      );
      this.sessionCatalogRevisions.set(catalogId, revision + 1);
      this.sessionCatalogRevision += 1;
    } catch (error) {
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== (this.sessionCatalogRevisions.get(catalogId) ?? 0) ||
        client !== this.gatewayClient
      ) {
        return;
      }
      // Preserve rows and cursors: retrying Load More requests this page again.
      this.sessionCatalogs = this.sessionCatalogs.map((candidate) =>
        candidate.id === catalogId
          ? { ...candidate, error: sessionCatalogRequestError(error) }
          : candidate,
      );
      this.sessionCatalogRevisions.set(catalogId, revision + 1);
      this.sessionCatalogRevision += 1;
    } finally {
      if (generation === this.sessionCatalogGeneration) {
        const loading = new Set(this.loadingMoreSessionCatalogIds);
        loading.delete(catalogId);
        this.loadingMoreSessionCatalogIds = loading;
      }
    }
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

  // Reading scrollHeight/scrollTop inside updated() forces a layout flush per
  // render; one rAF-coalesced read rides the layout computed for paint anyway.
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
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.sessionCatalogLive.resetConnection();
    this.sessionCatalogs = [];
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
  }

  private clearSessionCache() {
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
