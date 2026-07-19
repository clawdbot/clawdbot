import path from "node:path";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "conversation_deliveries"
  | "conversations"
  | "session_conversations"
  | "session_entries"
  | "session_routes"
  | "session_transcript_generations"
  | "sessions"
  | "trajectory_runtime_events"
  | "transcript_event_identities"
  | "transcript_events"
>;

export type ResolvedSqliteScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

export type ResolvedSqliteReadScope = {
  agentId: string;
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
  scope: Pick<SessionAccessScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteScope {
  const scopedAgentId = resolveExplicitSqliteAgentId(scope);
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath, { agentId: scopedAgentId })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
    useDefaultAgentForUnownedStore: Boolean(
      storeTarget?.path && !storeTarget.agentId && !scopedAgentId,
    ),
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    sessionKey: normalizeSqliteSessionKey(scope.sessionKey),
  };
}

export function resolveSqliteReadScope(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const scopedAgentId = resolveExplicitSqliteAgentId({ ...scope, sessionKey });
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath, { agentId: scopedAgentId })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
    useDefaultAgentForUnownedStore: Boolean(
      storeTarget?.path && !storeTarget.agentId && !scopedAgentId,
    ),
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite transcript read scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveExplicitSqliteAgentId(params: {
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  return params.agentId
    ? normalizeAgentId(params.agentId)
    : parseAgentSessionKey(params.sessionKey)?.agentId;
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
  useDefaultAgentForUnownedStore?: boolean;
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (scopedAgentId && params.storeAgentId && scopedAgentId !== params.storeAgentId) {
    throw new Error(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  const resolved =
    scopedAgentId ??
    params.storeAgentId ??
    (params.sessionKey !== undefined ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  return resolved ?? (params.useDefaultAgentForUnownedStore ? DEFAULT_AGENT_ID : undefined);
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
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope),
    sessionId: scope.sessionId,
  };
}

export function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.agentId,
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

export function formatSqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}
