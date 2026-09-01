import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type {
  SessionBranch,
  SessionsBranchesListResult,
  SessionsBranchesSwitchResult,
  SessionsCompactionBranchResult,
  SessionsCompactionListResult,
  SessionsCompactionRestoreResult,
  SessionsForkResult,
  SessionsListResult,
  SessionsPatchResult,
  SessionsRewindResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
  SessionWorkspaceSetResult,
} from "../../api/types.ts";
import type { SessionPatch } from "./patch.ts";
import type {
  SessionCompactResult,
  SessionDeleteOptions,
  SessionListOptions,
  SessionRequestClient,
  SessionResetOptions,
} from "./session-capability.ts";

/** Gateway rosters omit recency so Chat and Settings agree, and carry the shared
 *  sidebar page size: a roster smaller than the store empties whole categories
 *  whose newest session falls outside the page, so the remainder is reachable
 *  through the list's Load more control rather than lost. */
export const DEFAULT_SESSION_LIST_QUERY = {
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
} as const satisfies SessionListOptions;

/** Starting page size for the Sessions page's explicit, user-editable limit
 *  field, kept separate from the roster page so tuning one never moves the other. */
export const SESSIONS_PAGE_DEFAULT_LIMIT = 50;

const SESSION_LIST_PARAMS = {
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
} as const;

function buildSessionRequestParams(
  key: string,
  agentId?: string | null,
): { key: string; agentId?: string } {
  const normalizedKey = key.trim();
  const normalizedAgentId = agentId?.trim();
  return {
    key: normalizedKey,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

function buildTranscriptMutationParams(
  sessionKey: string,
  agentId?: string | null,
): { sessionKey: string; agentId?: string } {
  const normalizedSessionKey = sessionKey.trim();
  const normalizedAgentId = agentId?.trim();
  return {
    sessionKey: normalizedSessionKey,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

export function buildSessionListParams(options: SessionListOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = { ...SESSION_LIST_PARAMS };
  if (options.limit === undefined) {
    params.limit = DEFAULT_SESSION_LIST_QUERY.limit;
  } else if (options.limit > 0) {
    params.limit = Math.floor(options.limit);
  }
  if (options.includeGlobal !== undefined) {
    params.includeGlobal = options.includeGlobal;
  }
  if (options.includeUnknown !== undefined) {
    params.includeUnknown = options.includeUnknown;
  }
  if (options.configuredAgentsOnly !== undefined) {
    params.configuredAgentsOnly = options.configuredAgentsOnly;
  }
  if (options.includeDerivedTitles === true) {
    params.includeDerivedTitles = true;
  }
  if (options.includeLastMessage === true) {
    params.includeLastMessage = true;
  }
  if (options.archivedFilter === "archived") {
    params.archived = true;
  } else if (options.archivedFilter === "all") {
    params.archived = "all";
  }
  const activeMinutes =
    options.archivedFilter === "archived" || options.archivedFilter === "all"
      ? 0
      : typeof options.activeMinutes === "number" && options.activeMinutes > 0
        ? Math.floor(options.activeMinutes)
        : 0;
  if (activeMinutes > 0) {
    params.activeMinutes = activeMinutes;
  }
  const agentId = options.agentId?.trim();
  const spawnedBy = options.spawnedBy?.trim();
  const search = options.search?.trim();
  const ownerId = options.ownerId?.trim();
  if (options.ownerFirst === true) {
    params.ownerFirst = true;
  }
  if (options.involvingMe === true) {
    params.involvingMe = true;
  }
  if (options.boardFace) {
    params.boardFace = options.boardFace;
  }
  if (agentId) {
    params.agentId = agentId;
  }
  if (spawnedBy) {
    params.spawnedBy = spawnedBy;
  }
  if (search) {
    params.search = search;
  }
  if (ownerId) {
    params.ownerId = ownerId;
  }
  if (typeof options.offset === "number" && options.offset > 0) {
    params.offset = Math.floor(options.offset);
  }
  return params;
}

export async function requestSessionList(
  client: SessionRequestClient,
  options: SessionListOptions = {},
): Promise<SessionsListResult | null> {
  return requestSessionListParams(client, buildSessionListParams(options));
}

export async function requestSessionListParams(
  client: SessionRequestClient,
  params: Readonly<Record<string, unknown>>,
): Promise<SessionsListResult | null> {
  const result = await client.request<SessionsListResult | undefined>("sessions.list", params);
  return result ?? null;
}

export function requestSessionPatch(
  client: SessionRequestClient,
  key: string,
  patch: SessionPatch,
  options: {
    agentId?: string | null;
    expectedSessionId?: string | null;
    expectedMarkedUnreadAt?: number | null;
  } = {},
): Promise<SessionsPatchResult> {
  const expectedSessionId = options.expectedSessionId?.trim();
  const params = {
    ...buildSessionRequestParams(key, options.agentId),
    ...(expectedSessionId ? { expectedSessionId } : {}),
    ...(options.expectedMarkedUnreadAt !== undefined
      ? { expectedMarkedUnreadAt: options.expectedMarkedUnreadAt }
      : {}),
    ...patch,
  };
  return patch.archived === true
    ? client.request<SessionsPatchResult>("sessions.patch", params, SESSION_ARCHIVE_REQUEST_OPTIONS)
    : client.request<SessionsPatchResult>("sessions.patch", params);
}

export function requestSessionDelete(
  client: SessionRequestClient,
  key: string,
  options: SessionDeleteOptions = {},
): Promise<SessionsDeleteResult> {
  return client.request<SessionsDeleteResult>(
    "sessions.delete",
    {
      ...buildSessionRequestParams(key, options.agentId),
      deleteTranscript: options.deleteTranscript ?? true,
      ...(options.expectedSessionId ? { expectedSessionId: options.expectedSessionId } : {}),
      ...(options.archivedOnly === true ? { archivedOnly: true } : {}),
    },
    SESSION_ARCHIVE_REQUEST_OPTIONS,
  );
}

export function requestSessionReset(
  client: SessionRequestClient,
  key: string,
  options: SessionResetOptions = {},
): Promise<void> {
  return client
    .request("sessions.reset", buildSessionRequestParams(key, options.agentId))
    .then(() => undefined);
}

export function requestSessionCompact(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionCompactResult> {
  return client.request<SessionCompactResult>(
    "sessions.compact",
    buildSessionRequestParams(key, options.agentId),
  );
}

export function requestSessionFilesList(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null; path?: string; search?: string } = {},
): Promise<SessionWorkspaceListResult | null> {
  return client.request<SessionWorkspaceListResult | null>("sessions.files.list", {
    sessionKey: key,
    path: options.path ?? "",
    search: options.search ?? "",
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

export function requestSessionFile(
  client: SessionRequestClient,
  key: string,
  path: string,
  options: { agentId?: string | null } = {},
): Promise<SessionWorkspaceGetResult | null> {
  return client.request<SessionWorkspaceGetResult | null>("sessions.files.get", {
    sessionKey: key,
    path,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

export function requestSessionFileSet(
  client: SessionRequestClient,
  key: string,
  path: string,
  content: string,
  options: { agentId?: string | null; expectedHash: string },
): Promise<SessionWorkspaceSetResult | null> {
  return client.request<SessionWorkspaceSetResult | null>("sessions.files.set", {
    sessionKey: key,
    path,
    content,
    expectedHash: options.expectedHash,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

export function requestSessionCheckpoints(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionListResult> {
  return client.request<SessionsCompactionListResult>(
    "sessions.compaction.list",
    buildSessionRequestParams(key, options.agentId),
  );
}

export function requestSessionCheckpointBranch(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionBranchResult> {
  return client.request<SessionsCompactionBranchResult>("sessions.compaction.branch", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

export function requestSessionCheckpointRestore(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionRestoreResult> {
  return client.request<SessionsCompactionRestoreResult>("sessions.compaction.restore", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

export function requestSessionRewind(
  client: SessionRequestClient,
  key: string,
  entryId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsRewindResult> {
  return client.request<SessionsRewindResult>("sessions.rewind", {
    ...buildTranscriptMutationParams(key, options.agentId),
    entryId,
  });
}

export function requestSessionFork(
  client: SessionRequestClient,
  key: string,
  entryId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsForkResult> {
  return client.request<SessionsForkResult>("sessions.fork", {
    ...buildTranscriptMutationParams(key, options.agentId),
    entryId,
  });
}

export async function requestSessionBranches(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionBranch[]> {
  const result = await client.request<SessionsBranchesListResult>(
    "sessions.branches.list",
    buildTranscriptMutationParams(key, options.agentId),
  );
  return result.branches;
}

export function requestSessionBranchSwitch(
  client: SessionRequestClient,
  key: string,
  leafEntryId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsBranchesSwitchResult> {
  return client.request<SessionsBranchesSwitchResult>("sessions.branches.switch", {
    ...buildTranscriptMutationParams(key, options.agentId),
    leafEntryId,
  });
}
