import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { SessionCapability, SessionListSnapshot } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

type SidebarSessionListOwner = {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly sessionCreatedOrder: Map<string, number>;
  sessionResultsByAgent: Record<string, NonNullable<SessionListSnapshot["result"]>>;
  sessionsResult: SessionListSnapshot["result"];
  sessionsAgentId: SessionListSnapshot["agentId"];
  sessionsLoading: boolean;
  sessionMutationError: string | null;
  expandedAgentId(): string;
  requestSessionDataUpdate(): void;
};

function pruneSidebarSessionOrder(
  owner: SidebarSessionListOwner,
  retainedResults: readonly NonNullable<SessionListSnapshot["result"]>[],
): void {
  const visibleKeys = new Set(
    retainedResults.flatMap((result) => result.sessions.map((row) => row.key).filter(Boolean)),
  );
  for (const key of owner.sessionCreatedOrder.keys()) {
    if (!visibleKeys.has(key)) {
      owner.sessionCreatedOrder.delete(key);
    }
  }
}

function pruneSidebarAgentSessionCaches(
  owner: SidebarSessionListOwner,
  agentIds: readonly string[],
): void {
  const retainedAgentIds = new Set(agentIds.map(normalizeAgentId));
  for (const agentId of Object.keys(owner.sessionResultsByAgent)) {
    if (!retainedAgentIds.has(agentId)) {
      delete owner.sessionResultsByAgent[agentId];
    }
  }
  if (owner.sessionsAgentId && !retainedAgentIds.has(normalizeAgentId(owner.sessionsAgentId))) {
    owner.sessionsResult = null;
    owner.sessionsAgentId = null;
  }
  const retainedResults = Object.values(owner.sessionResultsByAgent);
  if (owner.sessionsResult) {
    retainedResults.push(owner.sessionsResult);
  }
  pruneSidebarSessionOrder(owner, retainedResults);
}

export function subscribeSidebarAgentSessionCaches(
  agents: AgentCapability,
  owner: SidebarSessionListOwner,
  notify: () => void,
): () => void {
  const synchronize = () => {
    const roster = agents.state.agentsList;
    // A null roster is transient during reconnect; only a concrete list can evict agent caches.
    if (roster) {
      pruneSidebarAgentSessionCaches(
        owner,
        roster.agents.map((agent) => agent.id),
      );
    }
  };
  synchronize();
  return agents.subscribe(() => {
    synchronize();
    notify();
  });
}

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
  const sessions = snapshot.result?.sessions ?? [];
  if (snapshot.result && snapshot.agentId) {
    owner.sessionResultsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result;
  }
  const retainedResults = snapshot.result
    ? [snapshot.result, ...Object.values(owner.sessionResultsByAgent)]
    : Object.values(owner.sessionResultsByAgent);
  pruneSidebarSessionOrder(owner, retainedResults);
  let nextCreatedOrder = 0;
  for (const order of owner.sessionCreatedOrder.values()) {
    nextCreatedOrder = Math.max(nextCreatedOrder, order + 1);
  }
  for (const row of sessions) {
    if (row.key && !owner.sessionCreatedOrder.has(row.key)) {
      owner.sessionCreatedOrder.set(row.key, nextCreatedOrder++);
    }
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
