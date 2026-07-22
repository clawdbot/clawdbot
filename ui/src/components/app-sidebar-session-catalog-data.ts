import { state } from "lit/decorators.js";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  CATALOG_SESSION_CONTINUED_EVENT,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
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
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

/** Gateway-backed external session-catalog synchronization. */
export abstract class AppSidebarSessionCatalogDataElement extends AppSidebarBase {
  @state() protected sessionCatalogs: SessionCatalog[] = [];
  @state() protected loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();

  private readonly sessionCatalogLive = new SessionCatalogLiveState();
  private sessionCatalogAgentId: string | null = null;
  private sessionCatalogGeneration = 0;
  private sessionCatalogRevision = 0;
  private readonly sessionCatalogPageDepths = new Map<string, number>();
  private readonly sessionCatalogRevisions = new Map<string, number>();

  protected abstract expandedAgentId(): string;
  protected abstract sessionCatalogGatewayClient(): GatewayBrowserClient | null;

  protected connectSessionCatalogListeners() {
    // The chat pane announces catalog adoptions so the catalog row binds to
    // the new session key before the next catalog poll.
    document.addEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.addEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.addEventListener("focus", this.handleSessionCatalogPageActivation);
  }

  protected disconnectSessionCatalogListeners() {
    document.removeEventListener(
      CATALOG_SESSION_CONTINUED_EVENT,
      this.handleCatalogSessionContinued as EventListener,
    );
    document.removeEventListener("visibilitychange", this.handleSessionCatalogPageActivation);
    globalThis.removeEventListener("focus", this.handleSessionCatalogPageActivation);
  }

  protected retireSessionCatalogData() {
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogLive.clear();
  }

  protected resetSessionCatalogConnection() {
    this.sessionCatalogGeneration += 1;
    this.sessionCatalogRevision += 1;
    this.sessionCatalogLive.resetConnection();
    this.sessionCatalogs = [];
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
  }

  protected updateSessionCatalogData() {
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

  protected handleSessionCatalogHostEvent(payload: unknown) {
    this.applySessionCatalogHostEvent(payload);
  }

  protected handleSessionCatalogPresence(payload: unknown) {
    if (this.sessionCatalogLive.observePresence(payload)) {
      this.requestSessionCatalogRefresh();
    }
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
      currentClient: () => this.sessionCatalogGatewayClient(),
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
        client !== this.sessionCatalogGatewayClient()
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
        client !== this.sessionCatalogGatewayClient()
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
}
