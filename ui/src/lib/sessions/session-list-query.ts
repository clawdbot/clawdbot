import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionRefreshOptions,
} from "./session-capability.ts";
import {
  buildSessionListParams,
  DEFAULT_SESSION_LIST_QUERY,
  normalizeManagedSessionListQuery,
} from "./session-requests.ts";

export type PublishedSession = {
  row: GatewaySessionRow;
  result: SessionsListResult;
  agentId?: string | null;
};

// Primary rows own shared presentation when both primary and managed queries hold a session.
export function findPublishedSession(
  state: { result: SessionsListResult | null; agentId?: string | null },
  managedLists: Iterable<{
    snapshot: { result: SessionsListResult | null };
    scope: SessionListScope;
  }>,
  matches: (row: GatewaySessionRow, agentId?: string | null) => boolean,
): PublishedSession | undefined {
  const primaryResult = state.result;
  const primary = primaryResult?.sessions.find((row) => matches(row, state.agentId));
  if (primary && primaryResult) {
    return { row: primary, result: primaryResult, agentId: state.agentId };
  }
  for (const entry of managedLists) {
    const result = entry.snapshot.result;
    const row = result?.sessions.find((candidate) => matches(candidate, entry.scope.agentId));
    if (row && result) {
      return { row, result, agentId: entry.scope.agentId };
    }
  }
  return undefined;
}

export type QueuedSessionRefresh = {
  options: SessionRefreshOptions;
  completions: Array<{
    options: SessionRefreshOptions;
    complete: (refresh: Promise<SessionsListResult | null> | null) => void;
  }>;
};

export function isPrimarySessionListQuery(options: SessionListScope): boolean {
  if (options.includeDerivedTitles === false || options.includeLastMessage === false) {
    return false;
  }
  const query = normalizeManagedSessionListQuery(options);
  return (
    query.archived === undefined &&
    !query.spawnedBy &&
    (query.boardFace ?? query.hasBoard) === undefined &&
    !query.activeMinutes &&
    !query.search &&
    !query.ownerId &&
    query.involvingMe !== true &&
    query.includeGlobal === true &&
    query.includeUnknown === true &&
    query.configuredAgentsOnly === true
  );
}

export function sessionListQueryAgentId(
  query: ReturnType<typeof normalizeManagedSessionListQuery>,
): string | undefined {
  return typeof query.agentId === "string" ? query.agentId : undefined;
}

export function isSameSessionListQuery(
  previous: SessionListScope,
  next: SessionListScope,
  append: boolean,
): boolean {
  const previousQuery = buildSessionListParams(previous);
  const nextQuery = buildSessionListParams(next);
  // Appending changes the page window without replacing its query owner.
  if (append) {
    previousQuery.limit = nextQuery.limit;
    previousQuery.ownerFirst = nextQuery.ownerFirst;
  }
  return JSON.stringify(previousQuery) === JSON.stringify(nextQuery);
}

export function prepareSessionRefreshOptions(
  options: SessionRefreshOptions,
  snapshot: SessionGateway["snapshot"],
): SessionRefreshOptions {
  // Every canonical roster replaces visible names, so omitted title enrichment
  // must inherit the UI default in both the request and its query identity.
  const prepared = { ...options, includeDerivedTitles: options.includeDerivedTitles ?? true };
  if (
    !snapshot.selfUser?.id.trim() ||
    prepared.append === true ||
    !isPrimarySessionListQuery(prepared)
  ) {
    return prepared;
  }
  return { ...prepared, ownerFirst: true };
}

export function completeSessionRefreshWaiters(
  queued: QueuedSessionRefresh,
  nextOptions: SessionRefreshOptions,
  next: Promise<SessionsListResult | null> | null,
  snapshot: SessionGateway["snapshot"],
): void {
  // Coalescing shares completion timing, but only equivalent queries share the result.
  queued.completions.forEach(({ options, complete }) => {
    const sameQuery = isSameSessionListQuery(
      prepareSessionRefreshOptions(options, snapshot),
      nextOptions,
      false,
    );
    complete(sameQuery ? next : (next?.then(() => null) ?? null));
  });
}

export function retainSessionPaginationWindow(
  options: SessionListOptions,
  offset: number | undefined,
  result: SessionsListResult | null,
  nextResult: SessionsListResult,
  snapshot: SessionGateway["snapshot"],
): SessionListOptions {
  const ownerFirstPage =
    Boolean(snapshot.selfUser?.id.trim()) && isPrimarySessionListQuery(options);
  const retainedListLimit =
    ownerFirstPage && result && typeof offset === "number"
      ? offset + result.sessions.length
      : nextResult.sessions.length;
  // Retain the shared pagination window, excluding owner rows merged ahead of it.
  return {
    ...options,
    limit: Math.max(options.limit ?? DEFAULT_SESSION_LIST_QUERY.limit, retainedListLimit),
  };
}
