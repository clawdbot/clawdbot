// Sanctioned low-level scope/Kysely entry point for doctor, migrations, and infrastructure.
// Runtime feature code imports the session accessor barrel instead of this module.
import path from "node:path";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import type {
  SessionAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "board_tabs"
  | "board_widgets"
  | "conversation_deliveries"
  | "conversations"
  | "heartbeat_outcomes"
  | "session_conversations"
  | "session_members"
  | "session_nodes"
  | "session_suggestions"
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_rewrite_watermarks"
  | "trajectory_runtime_events"
  | "transcript_event_identities"
  | "transcript_events"
> & {
  sqlite_schema: { name: string | null; type: string };
};

export type ResolvedSqliteScope = {
  agentId: string;
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

export type ResolvedSqliteReadScope = {
  agentId: string;
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey?: string;
};

export type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

export type SessionSqliteTargetResolutionCache = Map<
  NodeJS.ProcessEnv | undefined,
  Map<string, ReturnType<typeof resolveSqliteTargetFromSessionStorePath>>
>;

const SQLITE_SESSION_SLOW_WRITE_MS = 1_000;
const SQLITE_SESSION_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

export function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

export async function runExclusiveSqliteSessionWrite<T>(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseOptions = toDatabaseOptions(scope);
  const storePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const startedAt = Date.now();
  try {
    const result = await runQueuedStoreWrite({
      queues: SQLITE_SESSION_WRITER_QUEUES,
      storePath,
      label: "runExclusiveSqliteSessionWrite",
      fn,
    });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SQLITE_SESSION_SLOW_WRITE_MS) {
      getChildLogger({ subsystem: "session-sqlite" }).warn("slow SQLite session write", {
        agentId: scope.agentId,
        elapsedMs,
        storePath,
      });
    }
    return result;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn("SQLite session write failed", {
      agentId: scope.agentId,
      elapsedMs: Date.now() - startedAt,
      error,
      storePath,
    });
    throw error;
  }
}

export function resolveSqliteScope(
  scope: Pick<
    SessionAccessScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
): ResolvedSqliteScope {
  const parsedAgentId = parseAgentSessionKey(scope.sessionKey)?.agentId;
  const scopedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : parsedAgentId;
  const incognitoAgentId = isIncognitoSessionKey(scope.sessionKey)
    ? resolveAgentIdFromSessionKey(scope.sessionKey)
    : undefined;
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  const storeTarget = effectiveStorePath
    ? resolveSqliteTargetFromSessionStorePath(effectiveStorePath, {
        agentId: effectiveAgentId,
        defaultAgentId: scope.defaultAgentId,
        ...(scope.env ? { env: scope.env } : {}),
      })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
    storeShared: storeTarget?.shared,
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  const normalizedSessionKey = normalizeSqliteSessionKey(scope.sessionKey);
  const sessionKey =
    !normalizedSessionKey ||
    normalizedSessionKey === "global" ||
    normalizedSessionKey === "unknown" ||
    parseAgentSessionKey(normalizedSessionKey)
      ? normalizedSessionKey
      : toAgentStoreSessionKey({ agentId, requestKey: normalizedSessionKey });
  return {
    agentId,
    ...(storeTarget?.shared && storeTarget.agentId ? { databaseAgentId: storeTarget.agentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    sessionKey,
  };
}

export function resolveSqliteReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
  targetCache?: SessionSqliteTargetResolutionCache,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const scopedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : parsedAgentId;
  const incognitoAgentId = isIncognitoSessionKey(sessionKey)
    ? resolveAgentIdFromSessionKey(sessionKey)
    : undefined;
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  const storeTarget = effectiveStorePath
    ? resolveCachedSqliteStoreTarget(
        {
          agentId: effectiveAgentId,
          defaultAgentId: scope.defaultAgentId,
          env: scope.env,
          storePath: effectiveStorePath,
        },
        targetCache,
      )
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
    storeShared: storeTarget?.shared,
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite transcript read scope without an agent id");
  }
  return {
    agentId,
    ...(storeTarget?.shared && storeTarget.agentId ? { databaseAgentId: storeTarget.agentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveCachedSqliteStoreTarget(
  params: {
    agentId?: string;
    defaultAgentId?: string;
    env?: NodeJS.ProcessEnv;
    storePath: string;
  },
  targetCache: SessionSqliteTargetResolutionCache | undefined,
): ReturnType<typeof resolveSqliteTargetFromSessionStorePath> {
  if (!targetCache) {
    return resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      ...(params.env ? { env: params.env } : {}),
    });
  }
  // Store ownership is stable for this batch. Scope the cache to the caller so later requests
  // still observe owner changes after migration, install, or doctor flows.
  const envCache = targetCache.get(params.env) ?? new Map();
  targetCache.set(params.env, envCache);
  const cacheKey = JSON.stringify([params.storePath, params.agentId, params.defaultAgentId]);
  const cached = envCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    ...(params.env ? { env: params.env } : {}),
  });
  envCache.set(cacheKey, resolved);
  return resolved;
}

export function resolveSqliteStoreScope(
  storePath: string,
  options: { agentId?: string } = {},
): ResolvedSqliteScope {
  return resolveSqliteScope({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    sessionKey: "",
    storePath,
  });
}

function resolveSqliteAgentId(params: {
  scopedAgentId?: string;
  sessionKey?: string;
  storeAgentId?: string;
  storeShared?: boolean;
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (
    scopedAgentId &&
    params.storeAgentId &&
    scopedAgentId !== params.storeAgentId &&
    !params.storeShared
  ) {
    throw new Error(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  const parsedAgentId = params.sessionKey
    ? parseAgentSessionKey(params.sessionKey)?.agentId
    : undefined;
  return scopedAgentId ?? params.storeAgentId ?? parsedAgentId;
}

export function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): string {
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const databaseDir = path.dirname(databasePath);
  if (path.basename(databaseDir) !== "agent") {
    return databaseDir;
  }
  return path.join(path.dirname(databaseDir), "sessions");
}

export function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptScope {
  if (!scope.sessionId) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (!scope.sessionKey) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
  return {
    ...resolveSqliteScope({ ...scope, sessionKey: scope.sessionKey }),
    sessionId: scope.sessionId,
  };
}

export function resolveSqliteTranscriptReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
  targetCache?: SessionSqliteTargetResolutionCache,
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope, targetCache),
    sessionId: scope.sessionId,
  };
}

export function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "databaseAgentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.databaseAgentId ?? scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}

export function normalizeSqliteSessionKey(sessionKey: string): string {
  return normalizeStoreSessionKey(sessionKey);
}

export function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

export function formatSqliteSessionReferenceForScope(scope: ResolvedTranscriptScope): string {
  return scope.sessionKey;
}

/** Legacy identity string retained only for transcript artifact metadata and plugin contracts. */
export function formatLegacySqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}
