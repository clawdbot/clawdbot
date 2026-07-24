import path from "node:path";
import { tryResolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { getRuntimeConfig } from "../io.js";
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
  | "board_tabs"
  | "board_widgets"
  | "conversation_deliveries"
  | "conversations"
  | "heartbeat_outcomes"
  | "session_conversations"
  | "session_members"
  | "session_nodes"
  | "session_suggestions"
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
  scope: Pick<
    SessionAccessScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
): ResolvedSqliteScope {
  const scopedAgentId = resolveExplicitSqliteAgentId(scope);
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
        defaultAgentId:
          scope.defaultAgentId ?? tryResolveDefaultAgentId(getRuntimeConfig()) ?? "main",
        ...(scope.env ? { env: scope.env } : {}),
      })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
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
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const scopedAgentId = resolveExplicitSqliteAgentId({ ...scope, sessionKey });
  const incognitoAgentId = isIncognitoSessionKey(sessionKey)
    ? resolveAgentIdFromSessionKey(sessionKey)
    : undefined;
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  const storeTarget = effectiveStorePath
    ? resolveSqliteTargetFromSessionStorePath(effectiveStorePath, {
        agentId: effectiveAgentId,
        defaultAgentId:
          scope.defaultAgentId ?? tryResolveDefaultAgentId(getRuntimeConfig()) ?? "main",
        ...(scope.env ? { env: scope.env } : {}),
      })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
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
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (scopedAgentId && params.storeAgentId && scopedAgentId !== params.storeAgentId) {
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
