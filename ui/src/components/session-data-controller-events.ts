import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import { createSessionEventRefreshCoordinator } from "../lib/sessions/event-refresh-coordinator.ts";
import { readSessionChangedEvent } from "../lib/sessions/reconcile.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";

type SessionGatewayEventOwner = {
  presencePayload: PresencePayload | undefined;
  readonly sessionScopeGeneration: number;
  handleSessionCatalogHostEvent(payload: unknown): void;
  handleSessionCatalogPresence(payload: unknown): void;
  refreshSidebarSessions(agentId?: string): Promise<void>;
  requestSessionDataUpdate(): void;
};

type FilteredSessionRefreshScope = {
  agentId: string;
  archivedFilter: SidebarSessionStatusFilter;
  client: ApplicationContext<RouteId>["gateway"]["snapshot"]["client"];
  generation: number;
};

export function subscribeSessionDataGatewayEvents(
  gateway: ApplicationContext<RouteId>["gateway"],
  owner: SessionGatewayEventOwner,
  host: Pick<
    SessionDataControllerHost,
    "expandedAgentId" | "isConnected" | "sidebarSessionStatusFilter"
  >,
): () => void {
  let subscribed = true;
  let refreshScope: FilteredSessionRefreshScope | null = null;
  const scopeIsCurrent = () =>
    refreshScope !== null &&
    subscribed &&
    host.isConnected &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === refreshScope.client &&
    owner.sessionScopeGeneration === refreshScope.generation &&
    host.sidebarSessionStatusFilter() === refreshScope.archivedFilter &&
    normalizeAgentId(host.expandedAgentId()) === refreshScope.agentId;
  const refreshCoordinator = createSessionEventRefreshCoordinator({
    canRefresh: scopeIsCurrent,
    refresh: () =>
      refreshScope ? owner.refreshSidebarSessions(refreshScope.agentId) : Promise.resolve(),
  });
  const unsubscribe = gateway.subscribeEvents((event) => {
    if (event.event === "sessions.catalog.host") {
      owner.handleSessionCatalogHostEvent(event.payload);
      return;
    }
    if (event.event === "sessions.changed") {
      const archivedFilter = host.sidebarSessionStatusFilter();
      if (archivedFilter === "active") {
        return;
      }
      const agentId = normalizeAgentId(host.expandedAgentId());
      const sessionEvent = readSessionChangedEvent(event.payload);
      const payloadAgentId = asNullableRecord(event.payload)?.agentId;
      const eventAgentId =
        sessionEvent?.agentId ??
        parseAgentSessionKey(sessionEvent?.key)?.agentId ??
        (typeof payloadAgentId === "string" ? payloadAgentId : undefined);
      if (eventAgentId && normalizeAgentId(eventAgentId) !== agentId) {
        return;
      }
      const nextScope: FilteredSessionRefreshScope = {
        agentId,
        archivedFilter,
        client: gateway.snapshot.client,
        generation: owner.sessionScopeGeneration,
      };
      if (
        refreshScope &&
        (refreshScope.agentId !== nextScope.agentId ||
          refreshScope.archivedFilter !== nextScope.archivedFilter ||
          refreshScope.client !== nextScope.client ||
          refreshScope.generation !== nextScope.generation)
      ) {
        refreshCoordinator.reset();
      }
      refreshScope = nextScope;
      // Canonical debounce/max-wait and single-flight behavior belong to one
      // coordinator; scope checks retire stale agents, filters, and clients.
      refreshCoordinator.schedule();
      return;
    }
    if (event.event === "presence") {
      const presence = readPresenceEntries(event.payload);
      owner.presencePayload = presence ? { presence } : undefined;
      owner.requestSessionDataUpdate();
      owner.handleSessionCatalogPresence(event.payload);
    }
  });
  return () => {
    subscribed = false;
    refreshCoordinator.dispose();
    unsubscribe();
  };
}
