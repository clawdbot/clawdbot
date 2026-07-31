import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  SIDEBAR_AGENT_SESSION_LIST_LIMIT,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

type SidebarSessionPaginationOwner = {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly sessionScopeGeneration: number;
  readonly sessionCreatedOrder: Map<string, number>;
  readonly sidebarSessionPaginationState: SidebarSessionPaginationState;
  sessionMutationError: string | null;
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]>;
  sessionsAgentId: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  expandedAgentId(): string;
  requestSessionDataUpdate(): void;
};

export type SidebarSessionPaginationState = {
  listRequestToken: symbol | null;
  pageRequestToken: symbol | null;
  loadedScope?: {
    agentId: string;
    archivedFilter: SidebarSessionStatusFilter;
    generation: number;
  };
};

function publishSidebarSessionResult(
  owner: SidebarSessionPaginationOwner,
  agentId: string,
  result: SessionsListResult | null,
  archivedFilter: SidebarSessionStatusFilter,
  generation: number,
) {
  owner.sessionsResult = result;
  owner.sessionsAgentId = agentId;
  owner.sidebarSessionPaginationState.loadedScope = {
    agentId: normalizeAgentId(agentId),
    archivedFilter,
    generation,
  };
  if (result) {
    owner.sessionRowsByAgent[normalizeAgentId(agentId)] = result.sessions;
    for (const row of result.sessions) {
      if (row.key && !owner.sessionCreatedOrder.has(row.key)) {
        owner.sessionCreatedOrder.set(row.key, owner.sessionCreatedOrder.size);
      }
    }
  }
  owner.requestSessionDataUpdate();
}

function appendSidebarSessionResults(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const seen = new Set<string>();
  const sessions = [...previous.sessions, ...page.sessions].filter((row) => {
    if (!row.key || seen.has(row.key)) {
      return false;
    }
    seen.add(row.key);
    return true;
  });
  const totalCount = page.totalCount ?? previous.totalCount;
  const hasMore =
    page.hasMore ??
    (typeof totalCount === "number" && Number.isFinite(totalCount)
      ? sessions.length < totalCount
      : false);
  return {
    ...page,
    count: sessions.length,
    totalCount,
    hasMore,
    nextOffset: page.nextOffset ?? (hasMore ? sessions.length : null),
    sessions,
  };
}

export async function refreshSidebarSessions(
  owner: SidebarSessionPaginationOwner,
  agentId: string,
  statusFilter: () => SidebarSessionStatusFilter,
): Promise<void> {
  const context = owner.context;
  if (!context) {
    return;
  }
  const state = owner.sidebarSessionPaginationState;
  state.pageRequestToken = null;
  const archivedFilter = statusFilter();
  const loadedScope = state.loadedScope;
  const preservesVisibleScope =
    archivedFilter !== "active" &&
    loadedScope?.generation === owner.sessionScopeGeneration &&
    loadedScope.archivedFilter === archivedFilter &&
    loadedScope.agentId === normalizeAgentId(agentId) &&
    normalizeAgentId(owner.sessionsAgentId ?? "") === loadedScope.agentId;
  const options = {
    agentId,
    archivedFilter,
    limit: preservesVisibleScope
      ? Math.max(SIDEBAR_AGENT_SESSION_LIST_LIMIT, owner.sessionsResult?.sessions.length ?? 0)
      : SIDEBAR_AGENT_SESSION_LIST_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
  } as const;
  if (archivedFilter === "active") {
    // Retire archived/all completions before the active capability owns the list.
    state.listRequestToken = null;
    await context.sessions.refresh({ ...options, force: true });
    return;
  }

  const gateway = context.gateway;
  const client = gateway.snapshot.client;
  const generation = owner.sessionScopeGeneration;
  const token = Symbol(agentId);
  state.listRequestToken = token;
  owner.sessionsLoading = true;
  owner.requestSessionDataUpdate();
  const isCurrent = () =>
    state.listRequestToken === token &&
    owner.sessionScopeGeneration === generation &&
    owner.context === context &&
    owner.context.sessions === context.sessions &&
    owner.context.gateway === gateway &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === client &&
    normalizeAgentId(agentId) === normalizeAgentId(owner.expandedAgentId()) &&
    archivedFilter === statusFilter();
  try {
    const result = await context.sessions.list(options);
    if (isCurrent()) {
      publishSidebarSessionResult(owner, agentId, result, archivedFilter, generation);
    }
  } catch (error) {
    if (isCurrent()) {
      owner.sessionMutationError = String(error);
      owner.requestSessionDataUpdate();
    }
  } finally {
    if (state.listRequestToken === token && owner.sessionScopeGeneration === generation) {
      owner.sessionsLoading = false;
      owner.requestSessionDataUpdate();
    }
  }
}

export async function loadMoreSidebarSessions(
  owner: SidebarSessionPaginationOwner,
  statusFilter: () => SidebarSessionStatusFilter,
): Promise<void> {
  const context = owner.context;
  const previous = owner.sessionsResult;
  const agentId = owner.sessionsAgentId;
  // Gateway cursors are optional; accumulated rows provide the same next page.
  const offset =
    previous?.nextOffset === undefined ? previous?.sessions.length : previous.nextOffset;
  const state = owner.sidebarSessionPaginationState;
  // A pending first-page refresh owns the list; its old offset cannot safely
  // start a page that would append to a superseded session snapshot.
  if (
    !context ||
    owner.sessionsLoading ||
    !previous?.hasMore ||
    typeof offset !== "number" ||
    !agentId ||
    normalizeAgentId(agentId) !== normalizeAgentId(owner.expandedAgentId()) ||
    state.pageRequestToken !== null
  ) {
    return;
  }

  const gateway = context.gateway;
  const client = gateway.snapshot.client;
  const generation = owner.sessionScopeGeneration;
  const archivedFilter = statusFilter();
  const listRequestToken = state.listRequestToken;
  const token = Symbol(agentId);
  state.pageRequestToken = token;
  const isCurrent = () =>
    state.pageRequestToken === token &&
    owner.sessionScopeGeneration === generation &&
    owner.context === context &&
    owner.context.sessions === context.sessions &&
    owner.context.gateway === gateway &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === client &&
    archivedFilter === statusFilter() &&
    normalizeAgentId(agentId) === normalizeAgentId(owner.expandedAgentId()) &&
    (archivedFilter === "active" ||
      (state.listRequestToken === listRequestToken && owner.sessionsResult === previous));
  const options = {
    agentId,
    archivedFilter,
    limit: SIDEBAR_AGENT_SESSION_LIST_LIMIT,
    offset,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
  } as const;

  if (archivedFilter !== "active") {
    owner.sessionsLoading = true;
    owner.requestSessionDataUpdate();
  }

  try {
    if (archivedFilter === "active") {
      // Canonical active pages publish to all consumers; archived/all stay sidebar-local.
      await context.sessions.refresh({ ...options, append: true, force: true });
      return;
    }

    const page = await context.sessions.list(options);
    if (page && isCurrent()) {
      publishSidebarSessionResult(
        owner,
        agentId,
        appendSidebarSessionResults(previous, page),
        archivedFilter,
        generation,
      );
    }
  } catch (error) {
    if (isCurrent()) {
      owner.sessionMutationError = String(error);
      owner.requestSessionDataUpdate();
    }
  } finally {
    if (state.pageRequestToken === token && owner.sessionScopeGeneration === generation) {
      state.pageRequestToken = null;
      if (archivedFilter !== "active") {
        owner.sessionsLoading = false;
        owner.requestSessionDataUpdate();
      }
    }
  }
}
