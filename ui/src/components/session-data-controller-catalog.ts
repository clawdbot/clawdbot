import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
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
import {
  completePanelRefresh,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "./panel-refresh-status.ts";

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
  sessionCatalogRefreshStatus: PanelRefreshStatus;
  loadingMoreSessionCatalogIds: ReadonlySet<string>;
  readonly sessionCatalogLive: SessionCatalogLiveState;
  sessionCatalogAgentId: string | null;
  readonly sessionScopeGeneration: number;
  sessionCatalogRevision: number;
  readonly sessionCatalogPageDepths: Map<string, number>;
  readonly sessionCatalogRevisions: Map<string, number>;
  expandedAgentId(): string;
  sessionCatalogGatewayClient(): GatewayBrowserClient | null;
  synchronizeSessionScope(): void;
  requestSessionDataUpdate(): void;
  refreshSessionCatalogs(): Promise<void>;
}

function visibleSessionCatalogClient(owner: SessionCatalogDataOwner): GatewayBrowserClient | null {
  if (document.visibilityState === "hidden") {
    return null;
  }
  return sessionCatalogListClient(owner.context?.gateway.snapshot, owner.sessionDataHostConnected);
}

export function resolveSessionCatalogAgentId(
  owner: SessionCatalogDataOwner,
  candidateAgentId: string | null | undefined = owner.expandedAgentId(),
): string | null {
  const context = owner.context;
  const gateway = context?.gateway.snapshot;
  // Only an authoritative connected hello can revoke catalog ownership; a
  // transient reconnect still preserves its rows until the replacement lands.
  if (
    gateway?.phase === "connected" &&
    isGatewayMethodAdvertised(gateway, "sessions.catalog.list") === false
  ) {
    return null;
  }
  const agentsState = context?.agents.state;
  const agentsList =
    gateway?.phase === "connected" &&
    gateway.client &&
    agentsState?.connected &&
    agentsState.client === gateway.client
      ? agentsState.agentsList
      : null;
  if (agentsList) {
    const rawSelectedId = context ? context.agentSelection.state.selectedId : candidateAgentId;
    const selectedId = rawSelectedId?.trim() ? normalizeAgentId(rawSelectedId) : null;
    if (
      selectedId &&
      agentsList.agents.some((agent) => normalizeAgentId(agent.id) === selectedId)
    ) {
      return selectedId;
    }
    const defaultId = normalizeAgentId(agentsList.defaultId);
    return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === defaultId)
      ? defaultId
      : null;
  }
  if (gateway?.phase !== "connected" || !gateway.hello || !gateway.assistantAgentId) {
    return null;
  }
  const helloDefault = normalizeAgentId(gateway.assistantAgentId);
  const rawSelected = context?.agentSelection.state.selectedId;
  const selected = rawSelected?.trim() ? normalizeAgentId(rawSelected) : null;
  // An explicit pre-roster selection may target an agent hello knows nothing about;
  // defer until the roster can validate it instead of fetching the default's catalog.
  return selected && selected !== helloDefault ? null : helloDefault;
}

function requestSessionCatalogRefresh(owner: SessionCatalogDataOwner): void {
  const snapshot = owner.context?.gateway.snapshot;
  owner.sessionCatalogLive.requestRefresh({
    visible: document.visibilityState !== "hidden",
    connected:
      owner.isSessionDataHostConnected &&
      owner.sessionCatalogAgentId !== null &&
      Boolean(sessionCatalogListClient(snapshot, owner.sessionDataHostConnected)),
    generation: owner.sessionScopeGeneration,
    refresh: () => void owner.refreshSessionCatalogs(),
  });
}

export function scheduleSessionCatalogRefresh(owner: SessionCatalogDataOwner): void {
  if (document.visibilityState === "hidden") {
    owner.sessionCatalogLive.cancelScheduledRefreshes();
    return;
  }
  owner.sessionCatalogLive.scheduleActivation(() => requestSessionCatalogRefresh(owner));
}

export function updateSessionCatalogData(owner: SessionCatalogDataOwner, defer = false): void {
  if (owner.context) {
    owner.synchronizeSessionScope();
  }
  if (
    !visibleSessionCatalogClient(owner) ||
    owner.sessionCatalogLive.timer ||
    owner.sessionCatalogLive.requestGeneration === owner.sessionScopeGeneration
  ) {
    return;
  }
  if (defer && owner.sessionCatalogLive.hasRequested) {
    scheduleSessionCatalogRefresh(owner);
    return;
  }
  void owner.refreshSessionCatalogs();
}

export function applySessionCatalogPresence(
  owner: SessionCatalogDataOwner,
  payload: unknown,
): void {
  if (owner.sessionCatalogLive.observePresence(payload)) {
    scheduleSessionCatalogRefresh(owner);
  }
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
  if (
    update.materialChange &&
    owner.sessionCatalogLive.requestGeneration !== owner.sessionScopeGeneration
  ) {
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
  owner.synchronizeSessionScope();
  const agentId = owner.sessionCatalogAgentId;
  const client = visibleSessionCatalogClient(owner);
  if (!client || !agentId) {
    return;
  }
  const generation = owner.sessionScopeGeneration;
  const revision = owner.sessionCatalogRevision;
  await refreshSessionCatalogsLive({
    live: owner.sessionCatalogLive,
    client,
    agentId,
    generation,
    revision,
    currentGeneration: () => owner.sessionScopeGeneration,
    currentRevision: () => owner.sessionCatalogRevision,
    currentClient: () => owner.sessionCatalogGatewayClient(),
    catalogs: () => owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
    connected: () => owner.isSessionDataHostConnected,
    applyFinal: (catalogs, revisedCatalogIds) => {
      owner.sessionCatalogs = catalogs;
      owner.sessionCatalogRefreshStatus = completePanelRefresh();
      owner.requestSessionDataUpdate();
      for (const catalogId of revisedCatalogIds) {
        owner.sessionCatalogRevisions.set(
          catalogId,
          (owner.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
        );
      }
      owner.sessionCatalogRevision += 1;
    },
    applyError: (error) => {
      owner.sessionCatalogRefreshStatus = failPanelRefresh(
        owner.sessionCatalogRefreshStatus,
        sessionCatalogRequestError(error).message,
      );
      owner.requestSessionDataUpdate();
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
  const agentId = resolveSessionCatalogAgentId(owner);
  if (
    !client ||
    !owner.sessionDataHostConnected ||
    !agentId ||
    agentId !== owner.sessionCatalogAgentId
  ) {
    return;
  }
  const generation = owner.sessionScopeGeneration;
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
    if (generation === owner.sessionScopeGeneration) {
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
    generation === owner.sessionScopeGeneration &&
    revision === (owner.sessionCatalogRevisions.get(catalogId) ?? 0) &&
    client === owner.sessionCatalogGatewayClient()
  );
}
import type { ReactiveControllerHost } from "lit";
