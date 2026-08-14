import type {
  ControlModelSessionCatalogQuery,
  ControlModelSessionCatalogSnapshot,
} from "@openclaw/gateway-client/model/catalog";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { appendSessionResults, reconcileRosterPresentationMetadata } from "./reconcile.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionRefreshOptions,
  SessionState,
} from "./session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";

export function controlModelQuery(options: SessionListOptions): ControlModelSessionCatalogQuery {
  const query: Record<string, unknown> = {
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
    ...(options.spawnedBy?.trim() ? { spawnedBy: options.spawnedBy.trim() } : {}),
    ...(options.search?.trim() ? { search: options.search.trim() } : {}),
    ...(options.creatorId?.trim() ? { creatorId: options.creatorId.trim() } : {}),
    ...(options.boardFace ? { boardFace: options.boardFace } : {}),
    ...(options.activeMinutes && options.activeMinutes > 0
      ? { activeMinutes: Math.min(1_000_000, Math.floor(options.activeMinutes)) }
      : {}),
    ...(options.offset && options.offset > 0
      ? { offset: Math.min(1_000_000, Math.floor(options.offset)) }
      : {}),
    limit:
      options.limit !== undefined && options.limit > 0
        ? Math.min(1_000, Math.floor(options.limit))
        : 200,
    includeGlobal: options.includeGlobal ?? true,
    includeUnknown: options.includeUnknown ?? true,
    configuredAgentsOnly: options.configuredAgentsOnly ?? true,
    ...(options.includeDerivedTitles ? { includeDerivedTitles: true } : {}),
    ...(options.includeLastMessage ? { includeLastMessage: true } : {}),
    ...(options.archivedFilter === "archived"
      ? { archived: true }
      : options.archivedFilter === "all"
        ? { archived: "all" }
        : {}),
  };
  return query as ControlModelSessionCatalogQuery;
}

export function sessionsResultFromControlModel(
  snapshot: ControlModelSessionCatalogSnapshot,
): SessionsListResult {
  return {
    ts: snapshot.ts ?? snapshot.refreshedAt ?? Date.now(),
    path: snapshot.path ?? "sessions.list",
    count: snapshot.count,
    totalCount: snapshot.totalCount,
    ...(snapshot.limitApplied !== null ? { limitApplied: snapshot.limitApplied } : {}),
    ...(snapshot.offset !== null ? { offset: snapshot.offset } : {}),
    ...(snapshot.nextOffset !== null ? { nextOffset: snapshot.nextOffset } : {}),
    hasMore: snapshot.hasMore,
    creators: snapshot.creators as SessionsListResult["creators"],
    defaults: (snapshot.defaults as SessionsListResult["defaults"] | null) ?? {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: snapshot.sessions as unknown as GatewaySessionRow[],
  };
}

export function reconcileControlModelSnapshot(
  catalog: ControlModelSessionCatalogSnapshot,
  options: SessionRefreshOptions,
  currentState: SessionState,
  snapshot: SessionGateway["snapshot"],
): { result: SessionsListResult; agentId: string | null } {
  let result = sessionsResultFromControlModel(catalog);
  const { append = false, backgroundHydrate = false } = options;
  if (append && options.offset && currentState.result) {
    result = appendSessionResults(currentState.result, result);
  } else {
    result = reconcileRosterPresentationMetadata(result, currentState.result) ?? result;
  }
  const currentKey = snapshot.sessionKey?.trim();
  if (currentKey) {
    const currentAgentId = normalizeAgentId(
      parseAgentSessionKey(currentKey)?.agentId ?? resolveUiSelectedGlobalAgentId(snapshot),
    );
    const exactPreviousCurrentRow = currentState.result?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, currentKey),
    );
    const previousCurrentRow =
      exactPreviousCurrentRow ??
      (currentState.agentId === currentAgentId
        ? currentState.result?.sessions.find((row) =>
            uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey),
          )
        : undefined);
    const nextContainsCurrentRow = exactPreviousCurrentRow
      ? result.sessions.some((row) => areUiSessionKeysEquivalent(row.key, currentKey))
      : result.sessions.some((row) =>
          uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey),
        );
    if (
      previousCurrentRow &&
      (backgroundHydrate || previousCurrentRow.archived === true) &&
      !nextContainsCurrentRow
    ) {
      const sessions = [...result.sessions, previousCurrentRow];
      result = { ...result, count: sessions.length, sessions };
    }
  }
  return {
    result,
    agentId:
      typeof catalog.query.agentId === "string" && catalog.query.agentId.trim()
        ? normalizeAgentId(catalog.query.agentId)
        : null,
  };
}
