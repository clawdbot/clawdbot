import { state } from "lit/decorators.js";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import {
  mergeCatalogSessionRows,
  mergeSessionCatalogPage,
  preserveExpandedCatalogHost,
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
  @state() protected sessionsScrollState: SidebarSessionsScrollState = "none";
  @state() protected sessionCatalogs: SessionCatalog[] = [];
  @state() protected loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  @state() protected sessionMutationError: string | null = null;

  protected sessionRowsByAgent: Record<string, SessionsListResult["sessions"]> = {};
  protected sessionCreatedOrder = new Map<string, number>();

  private readonly subscriptions = new SubscriptionsController(this);
  private sessionsSource: SessionCapability | null = null;
  private reconnectListRevision: number | null = null;
  private gatewaySource: ApplicationContext<RouteId>["gateway"] | null = null;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  // Mutation completions belong to one context/capability/connection epoch.
  // Bumping this prevents old failures or batch tails crossing a reconnect.
  private sessionMutationEpoch = 0;
  private sessionsScrollElement: HTMLElement | null = null;
  private sessionsScrollResizeObserver: ResizeObserver | null = null;
  private sessionCatalogTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionCatalogAgentId: string | null = null;
  private sessionCatalogGeneration = 0;
  private sessionCatalogRevision = 0;
  private sessionCatalogRequestGeneration: number | null = null;
  private readonly sessionCatalogPageDepths = new Map<string, number>();
  private readonly sessionCatalogRevisions = new Map<string, number>();

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
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
      );
  }

  override connectedCallback() {
    super.connectedCallback();
    // The chat pane announces catalog adoptions so the catalog row binds to
    // the new session key before the next catalog poll.
    document.addEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
  }

  override disconnectedCallback() {
    document.removeEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    this.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.sessionCatalogGeneration += 1;
    this.sessionsScrollResizeObserver?.disconnect();
    this.sessionsScrollResizeObserver = null;
    this.sessionsScrollElement = null;
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
    super.disconnectedCallback();
  }

  override updated() {
    this.syncSessionsScrollObserver();
    const snapshot = this.context?.gateway.snapshot;
    if (this.context) {
      this.synchronizeSessionCatalogAgent(this.expandedAgentId());
    }
    if (
      !snapshot?.connected ||
      !snapshot.client ||
      isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true ||
      this.sessionCatalogTimer ||
      this.sessionCatalogRequestGeneration === this.sessionCatalogGeneration
    ) {
      return;
    }
    void this.refreshSessionCatalogs();
  }

  private synchronizeSessionCatalogAgent(agentId: string) {
    if (agentId === this.sessionCatalogAgentId) {
      return;
    }
    this.sessionCatalogAgentId = agentId;
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.loadingMoreSessionCatalogIds = new Set();
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
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

  private async refreshSessionCatalogs() {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.connected) {
      return;
    }
    const generation = this.sessionCatalogGeneration;
    const revision = this.sessionCatalogRevision;
    const agentId = this.sessionCatalogAgentId ?? this.expandedAgentId();
    if (this.sessionCatalogRequestGeneration === generation) {
      return;
    }
    this.sessionCatalogRequestGeneration = generation;
    try {
      const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
        agentId,
        limitPerHost: 40,
      });
      if (generation !== this.sessionCatalogGeneration || client !== this.gatewayClient) {
        return;
      }
      const catalogs = await this.refetchSessionCatalogPages({
        catalogs: result.catalogs,
        client,
        generation,
        agentId,
      });
      if (
        generation !== this.sessionCatalogGeneration ||
        revision !== this.sessionCatalogRevision ||
        client !== this.gatewayClient
      ) {
        return;
      }
      const revisedCatalogIds = new Set([
        ...this.sessionCatalogs.map((catalog) => catalog.id),
        ...catalogs.map((catalog) => catalog.id),
      ]);
      this.sessionCatalogs = catalogs;
      for (const catalogId of revisedCatalogIds) {
        this.sessionCatalogRevisions.set(
          catalogId,
          (this.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
        );
      }
      this.sessionCatalogRevision += 1;
    } catch {
      // A transient poll failure must not collapse already visible or expanded pages.
    } finally {
      if (this.sessionCatalogRequestGeneration === generation) {
        this.sessionCatalogRequestGeneration = null;
      }
      if (
        generation === this.sessionCatalogGeneration &&
        client === this.gatewayClient &&
        this.isConnected
      ) {
        this.sessionCatalogTimer = globalThis.setTimeout(() => {
          this.sessionCatalogTimer = null;
          void this.refreshSessionCatalogs();
        }, 30_000);
      }
    }
  }

  private async refetchSessionCatalogPages(params: {
    catalogs: SessionCatalog[];
    client: GatewayBrowserClient;
    generation: number;
    agentId: string;
  }): Promise<SessionCatalog[]> {
    const previousCatalogs = new Map(this.sessionCatalogs.map((catalog) => [catalog.id, catalog]));
    return Promise.all(
      params.catalogs.map(async (catalog) => {
        const previousHosts = new Map(
          previousCatalogs.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
        );
        const hosts = await Promise.all(
          catalog.hosts.map(async (host) => {
            const key = sessionCatalogHostKey(catalog.id, host.hostId);
            const pageDepth = this.sessionCatalogPageDepths.get(key) ?? 0;
            if (pageDepth === 0) {
              return host;
            }
            const previous = previousHosts.get(host.hostId);
            if (host.error) {
              return preserveExpandedCatalogHost(host, previous);
            }
            let sessions = host.sessions;
            let nextCursor = host.nextCursor;
            let loadedPages = 0;
            for (; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
              let result: SessionsCatalogListResult;
              try {
                result = await params.client.request<SessionsCatalogListResult>(
                  "sessions.catalog.list",
                  {
                    agentId: params.agentId,
                    catalogId: catalog.id,
                    cursors: { [host.hostId]: nextCursor },
                  },
                );
              } catch {
                return previous ?? host;
              }
              if (
                params.generation !== this.sessionCatalogGeneration ||
                params.client !== this.gatewayClient
              ) {
                return previous ?? host;
              }
              const pageHost = result.catalogs
                .find((candidate) => candidate.id === catalog.id)
                ?.hosts.find((candidate) => candidate.hostId === host.hostId);
              if (!pageHost) {
                return previous ?? host;
              }
              if (pageHost.error) {
                return preserveExpandedCatalogHost({ ...host, ...pageHost }, previous ?? host);
              }
              sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
              nextCursor = pageHost.nextCursor;
            }
            const {
              nextCursor: _firstPageCursor,
              sessions: _firstPageSessions,
              ...freshHost
            } = host;
            return {
              ...freshHost,
              sessions,
              ...(nextCursor ? { nextCursor } : {}),
            };
          }),
        );
        return { ...catalog, hosts };
      }),
    );
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
    const element = this.querySelector<HTMLElement>(".sidebar-recent-sessions");
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
      this.updateSessionsScrollState(element);
    }
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
    const sourceOrClientChanged = gateway !== this.gatewaySource || client !== this.gatewayClient;
    const connectionChanged = connected !== this.gatewayConnected;
    if (!sourceOrClientChanged && !connectionChanged) {
      return;
    }
    this.invalidateSessionMutations();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    if (!sourceOrClientChanged) {
      return;
    }
    this.clearSessionCache();
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    if (this.sessionCatalogTimer) {
      globalThis.clearTimeout(this.sessionCatalogTimer);
      this.sessionCatalogTimer = null;
    }
    this.sessionCatalogs = [];
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
  }

  private clearSessionCache() {
    this.reconnectListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionRowsByAgent = {};
    this.sessionCreatedOrder.clear();
    this.visibleSessionLimit = SIDEBAR_SESSION_PAGE_SIZE;
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
