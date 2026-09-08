import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../lib/sessions/catalog-key.ts";
import type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
} from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type {
  SidebarSessionOwnerFilter,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

// Chat panes announce catalog adoptions before the next poll so rows bind immediately.
export function subscribeSessionCatalogBrowserEvents(
  onContinued: EventListener,
  onPageActivation: EventListener,
): () => void {
  document.addEventListener(CATALOG_SESSION_CONTINUED_EVENT, onContinued);
  document.addEventListener("visibilitychange", onPageActivation);
  globalThis.addEventListener("focus", onPageActivation);
  return () => {
    document.removeEventListener(CATALOG_SESSION_CONTINUED_EVENT, onContinued);
    document.removeEventListener("visibilitychange", onPageActivation);
    globalThis.removeEventListener("focus", onPageActivation);
  };
}

type SidebarSessionListOwner = {
  readonly context: ApplicationContext<RouteId> | undefined;
  sessionResultsByAgent: Record<string, NonNullable<SessionListSnapshot["result"]>>;
  sessionsResult: SessionListSnapshot["result"];
  sessionsAgentId: SessionListSnapshot["agentId"];
  sessionsLoading: boolean;
  sessionMutationError: string | null;
  expandedAgentId(): string;
  sessionListQuery(agentId: string): SessionListOptions;
  requestSessionDataUpdate(): void;
};

const sidebarSessionErrorOwners = new WeakMap<SidebarSessionListOwner, "list" | "action">();

export function publishSidebarSessionError(
  owner: SidebarSessionListOwner,
  error: string | null,
  source: "list" | "action",
): void {
  if (source === "list" && sidebarSessionErrorOwners.get(owner) === "action") {
    return;
  }
  owner.sessionMutationError = error;
  if (error === null) {
    sidebarSessionErrorOwners.delete(owner);
  } else {
    sidebarSessionErrorOwners.set(owner, source);
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

type SidebarSessionQueryOwner = {
  sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
};

export function hasSidebarListFilter(owner: SidebarSessionQueryOwner): boolean {
  const { ownerId, involvingMe } = owner.sidebarSessionOwnerFilter();
  return owner.sidebarSessionStatusFilter() !== "active" || Boolean(ownerId || involvingMe);
}

export function sidebarSessionListQuery(owner: SidebarSessionQueryOwner, agentId: string) {
  const { ownerId, involvingMe } = owner.sidebarSessionOwnerFilter();
  return {
    ownerId: involvingMe ? undefined : ownerId || undefined,
    involvingMe: involvingMe || undefined,
    agentId,
    archivedFilter: owner.sidebarSessionStatusFilter(),
    limit: SIDEBAR_SESSION_ROSTER_LIMIT,
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
  if (snapshot.result && snapshot.agentId) {
    owner.sessionResultsByAgent[normalizeAgentId(snapshot.agentId)] = snapshot.result;
  }
}

export function subscribeFilteredSidebarSessions(
  owner: SidebarSessionListOwner,
  sessions: SessionCapability,
  scope: SessionListOptions,
  isCurrent: () => boolean,
): () => void {
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
    publishSidebarSessionError(owner, snapshot.error, "list");
    owner.requestSessionDataUpdate();
  };
  const unsubscribe = sessions.subscribeList(scope, apply);
  apply(sessions.listSnapshot(scope));
  return () => {
    unsubscribe();
    publishSidebarSessionError(owner, null, "list");
  };
}

export function refreshSidebarSessionList(
  owner: SidebarSessionListOwner,
  agentId: string | null,
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
    ...owner.sessionListQuery(agentId),
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
