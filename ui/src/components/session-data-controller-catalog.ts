import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
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
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";

export interface SessionDataControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly connected: boolean;
  readonly sessionDataContext: ApplicationContext<RouteId> | undefined;
  dismissTransientMenus(): boolean;
  expandedAgentId(): string;
  promoteCreatedSession(sessionKey: string): void;
  selectedAgentIdForSessions(): string;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
  querySelector(selectors: string): Element | null;
}

export interface SessionCatalogDataOwner {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly isSessionDataHostConnected: boolean;
  readonly sessionDataHostConnected: boolean;
  sessionCatalogs: SessionCatalog[];
  loadingMoreSessionCatalogIds: ReadonlySet<string>;
  readonly sessionCatalogLive: SessionCatalogLiveState;
  sessionCatalogAgentId: string | null;
  sessionCatalogGeneration: number;
  sessionCatalogRevision: number;
  readonly sessionCatalogPageDepths: Map<string, number>;
  readonly sessionCatalogRevisions: Map<string, number>;
  expandedAgentId(): string;
  sessionCatalogGatewayClient(): GatewayBrowserClient | null;
  requestSessionDataUpdate(): void;
  refreshSessionCatalogs(): Promise<void>;
}

export function visibleSessionCatalogClient(
  owner: SessionCatalogDataOwner,
): GatewayBrowserClient | null {
  if (document.visibilityState === "hidden") {
    return null;
  }
  return sessionCatalogListClient(owner.context?.gateway.snapshot, owner.sessionDataHostConnected);
}

export function synchronizeSessionCatalogAgent(
  owner: SessionCatalogDataOwner,
  agentId: string,
): void {
  if (agentId === owner.sessionCatalogAgentId) {
    return;
  }
  owner.sessionCatalogAgentId = agentId;
  owner.sessionCatalogGeneration += 1;
  owner.sessionCatalogRevision += 1;
  owner.sessionCatalogLive.clear();
  owner.loadingMoreSessionCatalogIds = new Set();
  if (owner.sessionCatalogs.some((catalog) => catalog.capabilities.createSession)) {
    owner.sessionCatalogs = owner.sessionCatalogs.map((catalog) => {
      const { createSession: _createSession, ...capabilities } = catalog.capabilities;
      return { ...catalog, capabilities };
    });
  }
  owner.requestSessionDataUpdate();
}

export function requestSessionCatalogRefresh(owner: SessionCatalogDataOwner): void {
  const snapshot = owner.context?.gateway.snapshot;
  owner.sessionCatalogLive.requestRefresh({
    visible: document.visibilityState !== "hidden",
    connected:
      owner.isSessionDataHostConnected &&
      Boolean(sessionCatalogListClient(snapshot, owner.sessionDataHostConnected)),
    generation: owner.sessionCatalogGeneration,
    refresh: () => void owner.refreshSessionCatalogs(),
  });
}

export function applySessionCatalogHostEvent(
  owner: SessionCatalogDataOwner,
  payload: unknown,
): void {
  const update = owner.sessionCatalogLive.applyHost({
    payload,
    agentId: owner.sessionCatalogAgentId ?? "",
    catalogs: owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
  });
  if (!update) {
    return;
  }
  owner.sessionCatalogs = update.catalogs;
  owner.requestSessionDataUpdate();
  owner.sessionCatalogRevision += owner.sessionCatalogLive.refetching ? 1 : 0;
  const catalogRevision = owner.sessionCatalogRevisions.get(update.catalogId) ?? 0;
  owner.sessionCatalogRevisions.set(update.catalogId, catalogRevision + 1);
  if (owner.sessionCatalogLive.requestGeneration !== owner.sessionCatalogGeneration) {
    owner.sessionCatalogLive.schedule(
      SESSION_CATALOG_CHANGED_REFRESH_MS,
      owner.isSessionDataHostConnected,
      () => void owner.refreshSessionCatalogs(),
    );
  }
}

export async function refreshSessionCatalogs(owner: SessionCatalogDataOwner): Promise<void> {
  // Hidden pages resume through the coalesced activation handler. Starting
  // here without a timer makes catalog state updates poll at request latency.
  const client = visibleSessionCatalogClient(owner);
  if (!client) {
    return;
  }
  const generation = owner.sessionCatalogGeneration;
  const revision = owner.sessionCatalogRevision;
  const agentId = owner.sessionCatalogAgentId ?? owner.expandedAgentId();
  await refreshSessionCatalogsLive({
    live: owner.sessionCatalogLive,
    client,
    agentId,
    generation,
    revision,
    currentGeneration: () => owner.sessionCatalogGeneration,
    currentRevision: () => owner.sessionCatalogRevision,
    currentClient: () => owner.sessionCatalogGatewayClient(),
    catalogs: () => owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
    connected: () => owner.isSessionDataHostConnected,
    applyFinal: (catalogs, revisedCatalogIds) => {
      owner.sessionCatalogs = catalogs;
      owner.requestSessionDataUpdate();
      for (const catalogId of revisedCatalogIds) {
        owner.sessionCatalogRevisions.set(
          catalogId,
          (owner.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
        );
      }
      owner.sessionCatalogRevision += 1;
    },
    refresh: () => void owner.refreshSessionCatalogs(),
  });
}

export async function loadMoreSessionCatalog(
  owner: SessionCatalogDataOwner,
  catalogId: string,
): Promise<void> {
  if (owner.loadingMoreSessionCatalogIds.has(catalogId)) {
    return;
  }
  const catalog = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
  const cursors = Object.fromEntries(
    (catalog?.hosts ?? []).flatMap((host) =>
      host.nextCursor ? [[host.hostId, host.nextCursor] as const] : [],
    ),
  );
  if (!catalog || Object.keys(cursors).length === 0) {
    return;
  }
  const client = owner.context?.gateway.snapshot.client;
  if (!client || !owner.sessionDataHostConnected) {
    return;
  }
  const generation = owner.sessionCatalogGeneration;
  const agentId = owner.sessionCatalogAgentId ?? owner.expandedAgentId();
  const revision = owner.sessionCatalogRevisions.get(catalogId) ?? 0;
  owner.loadingMoreSessionCatalogIds = new Set([...owner.loadingMoreSessionCatalogIds, catalogId]);
  owner.requestSessionDataUpdate();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      catalogId,
      cursors,
    });
    if (!isCurrentSessionCatalogRequest(owner, catalogId, client, generation, revision)) {
      return;
    }
    const page = result.catalogs.find((candidate) => candidate.id === catalogId);
    const current = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
    if (!page || !current) {
      return;
    }
    const merged = mergeSessionCatalogPage({ current, page, cursors });
    for (const hostId of merged.advancedHostIds) {
      const key = sessionCatalogHostKey(catalogId, hostId);
      owner.sessionCatalogPageDepths.set(key, (owner.sessionCatalogPageDepths.get(key) ?? 0) + 1);
    }
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId ? merged.catalog : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevisions.set(catalogId, revision + 1);
    owner.sessionCatalogRevision += 1;
  } catch (error) {
    if (!isCurrentSessionCatalogRequest(owner, catalogId, client, generation, revision)) {
      return;
    }
    // Preserve rows and cursors: retrying Load More requests this page again.
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId
        ? { ...candidate, error: sessionCatalogRequestError(error) }
        : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevisions.set(catalogId, revision + 1);
    owner.sessionCatalogRevision += 1;
  } finally {
    if (generation === owner.sessionCatalogGeneration) {
      const loading = new Set(owner.loadingMoreSessionCatalogIds);
      loading.delete(catalogId);
      owner.loadingMoreSessionCatalogIds = loading;
      owner.requestSessionDataUpdate();
    }
  }
}

function isCurrentSessionCatalogRequest(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  client: GatewayBrowserClient,
  generation: number,
  revision: number,
): boolean {
  return (
    generation === owner.sessionCatalogGeneration &&
    revision === (owner.sessionCatalogRevisions.get(catalogId) ?? 0) &&
    client === owner.sessionCatalogGatewayClient()
  );
}
import type { ReactiveControllerHost } from "lit";
