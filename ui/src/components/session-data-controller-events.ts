import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import type { SessionCapability, SessionListSnapshot } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

type SidebarSessionListOwner = {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly sessionCreatedOrder: Map<string, number>;
  sessionRowsByAgent: Record<string, NonNullable<SessionListSnapshot["result"]>["sessions"]>;
  sessionsResult: SessionListSnapshot["result"];
  sessionsAgentId: SessionListSnapshot["agentId"];
  sessionsLoading: boolean;
  sessionMutationError: string | null;
  expandedAgentId(): string;
  requestSessionDataUpdate(): void;
};

function filteredSidebarSessionQuery(agentId: string, archivedFilter: SidebarSessionStatusFilter) {
  return {
    agentId,
    archivedFilter,
    limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
    includeDerivedTitles: true,
    includeLastMessage: true,
  } as const;
}

export function publishSidebarSessionList(
  owner: SidebarSessionListOwner,
  snapshot: SessionListSnapshot,
): void {
  owner.sessionsResult = snapshot.result;
  owner.sessionsAgentId = snapshot.agentId;
  for (const row of snapshot.result?.sessions ?? []) {
    if (row.key && !owner.sessionCreatedOrder.has(row.key)) {
      owner.sessionCreatedOrder.set(row.key, owner.sessionCreatedOrder.size);
    }
  }
  if (snapshot.result && snapshot.agentId) {
    owner.sessionRowsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result.sessions;
  }
}

export function subscribeFilteredSidebarSessions(
  owner: SidebarSessionListOwner,
  sessions: SessionCapability,
  agentId: string,
  archivedFilter: Exclude<SidebarSessionStatusFilter, "active">,
  isCurrent: () => boolean,
): () => void {
  const scope = filteredSidebarSessionQuery(agentId, archivedFilter);
  const apply = (snapshot: SessionListSnapshot) => {
    if (!isCurrent()) {
      return;
    }
    // Keep visible rows across reconnect until the new connection owns a fresh list.
    if (owner.context?.gateway.snapshot.phase !== "connected" && !snapshot.result) {
      return;
    }
    publishSidebarSessionList(owner, snapshot);
    owner.sessionsLoading = snapshot.loading;
    if (snapshot.error) {
      owner.sessionMutationError = snapshot.error;
    }
    owner.requestSessionDataUpdate();
  };
  const unsubscribe = sessions.subscribeList(scope, apply);
  apply(sessions.listSnapshot(scope));
  return unsubscribe;
}

export function refreshSidebarSessionList(
  owner: SidebarSessionListOwner,
  agentId: string | null,
  archivedFilter: SidebarSessionStatusFilter,
  append = false,
): Promise<void> {
  const result = owner.sessionsResult;
  // An omitted cursor falls back to accumulated rows; an explicit null is terminal.
  const offset = result?.nextOffset === undefined ? result?.sessions.length : result.nextOffset;
  if (
    !owner.context?.sessions ||
    !agentId ||
    (append &&
      (owner.sessionsLoading ||
        !result?.hasMore ||
        typeof offset !== "number" ||
        normalizeAgentId(agentId) !== normalizeAgentId(owner.expandedAgentId())))
  ) {
    return Promise.resolve();
  }
  return owner.context.sessions.refreshList({
    ...filteredSidebarSessionQuery(agentId, archivedFilter),
    ...(append && typeof offset === "number" ? { offset, append: true } : {}),
    force: true,
  });
}

type SessionGatewayEventOwner = {
  presencePayload: PresencePayload | undefined;
  handleSessionCatalogHostEvent(payload: unknown): void;
  handleSessionCatalogPresence(payload: unknown): void;
  requestSessionDataUpdate(): void;
};

export function subscribeSessionDataGatewayEvents(
  gateway: ApplicationContext<RouteId>["gateway"],
  owner: SessionGatewayEventOwner,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "sessions.catalog.host") {
      owner.handleSessionCatalogHostEvent(event.payload);
      return;
    }
    if (event.event === "presence") {
      const presence = readPresenceEntries(event.payload);
      owner.presencePayload = presence ? { presence } : undefined;
      owner.requestSessionDataUpdate();
      owner.handleSessionCatalogPresence(event.payload);
    }
  });
}
