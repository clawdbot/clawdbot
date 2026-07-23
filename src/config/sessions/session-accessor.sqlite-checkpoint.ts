import { randomUUID } from "node:crypto";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSqliteSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  formatSqliteSessionMarkerForScope,
  getSessionKysely,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-transcript-store.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "./types.js";

// Compaction checkpoint branch/restore owner.

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

/** Result from SQLite compaction checkpoint branch or restore operations. */
type SqliteCompactionCheckpointSessionMutationResult =
  | {
      status: "created";
      key: string;
      checkpoint: SessionCompactionCheckpoint;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "missing-checkpoint" }
  | { status: "missing-boundary" }
  | { status: "failed" };

/** Parameters for branching a SQLite session from a compaction checkpoint. */
type SqliteBranchCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
};

export async function branchSqliteCompactionCheckpointSession(
  params: SqliteBranchCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sourceKey = normalizeSqliteSessionKey(params.sourceStoreKey ?? params.sourceKey);
  const targetKey = normalizeSqliteSessionKey(params.nextKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SqliteCompactionCheckpointSessionMutationResult | undefined;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sourceKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
      result = branchSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        parentSessionKey: normalizeSqliteSessionKey(params.sourceKey),
        resolved,
        sourceKey,
        targetKey,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result ?? { status: "failed" };
  });
}

/** Restores a SQLite session from a compaction checkpoint in one queued transaction. */
export async function restoreSqliteCompactionCheckpointSession(
  params: SqliteRestoreCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sessionKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const targetKey = normalizeSqliteSessionKey(params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SqliteCompactionCheckpointSessionMutationResult | undefined;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sessionKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
      result = restoreSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        resolved,
        sourceKey: sessionKey,
        targetKey,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result ?? { status: "failed" };
  });
}

/** Publishes a transcript update using the SQLite transcript scope target. */

function branchSqliteCompactionCheckpointSessionInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    checkpointId: string;
    parentSessionKey: string;
    resolved: ResolvedSqliteScope;
    sourceKey: string;
    targetKey: string;
  },
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, params.checkpointId);
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const forked = forkSqliteCheckpointTranscriptInTransaction(database, params.resolved, {
    checkpoint,
    targetSessionKey: params.targetKey,
  });
  if (forked.status !== "created") {
    return forked;
  }

  const label = currentEntry.label?.trim()
    ? `${currentEntry.label.trim()} (checkpoint)`
    : "Checkpoint branch";
  const nextEntry = cloneSqliteCheckpointSessionEntry({
    currentEntry,
    label,
    nextSessionId: forked.sessionId,
    parentSessionKey: params.parentSessionKey,
    totalTokens: forked.totalTokens,
  });
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function restoreSqliteCompactionCheckpointSessionInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    checkpointId: string;
    resolved: ResolvedSqliteScope;
    sourceKey: string;
    targetKey: string;
  },
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, params.checkpointId);
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const restored = forkSqliteCheckpointTranscriptInTransaction(database, params.resolved, {
    checkpoint,
    targetSessionKey: params.targetKey,
  });
  if (restored.status !== "created") {
    return restored;
  }

  const nextEntry = cloneSqliteCheckpointSessionEntry({
    currentEntry,
    nextSessionId: restored.sessionId,
    preserveCompactionCheckpoints: true,
    totalTokens: restored.totalTokens,
  });
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function forkSqliteCheckpointTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    checkpoint: SessionCompactionCheckpoint;
    targetSessionKey: string;
  },
):
  | {
      status: "created";
      sessionId: string;
      sessionFile: string;
      totalTokens?: number;
    }
  | { status: "missing-boundary" }
  | { status: "failed" } {
  const sources = resolveSqliteCheckpointTranscriptForkSources(params.checkpoint);
  if (sources.length === 0) {
    return { status: "missing-boundary" };
  }
  let lastFailure: { status: "missing-boundary" } | { status: "failed" } = {
    status: "missing-boundary",
  };
  let selected:
    | {
        source: SqliteCheckpointTranscriptForkSource;
        rows: TranscriptEvent[];
      }
    | undefined;
  for (const source of sources) {
    const rows = readSqliteTranscriptRowsForFork(database, source);
    if (rows.status === "created") {
      selected = { source, rows: rows.events };
      break;
    }
    lastFailure = rows;
  }
  if (!selected) {
    return lastFailure;
  }

  const sessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: params.targetSessionKey,
  };
  const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
  appendTranscriptEventsInTransaction(database, targetScope, [
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selected.rows),
      sessionId,
    }),
    ...selected.rows.filter((event) => !isSessionTranscriptHeader(event)),
  ]);
  return {
    status: "created",
    sessionId,
    sessionFile,
    ...(typeof selected.source.totalTokens === "number"
      ? { totalTokens: selected.source.totalTokens }
      : {}),
  };
}

function resolveSqliteCheckpointTranscriptForkSources(
  checkpoint: SessionCompactionCheckpoint,
): SqliteCheckpointTranscriptForkSource[] {
  const sources: SqliteCheckpointTranscriptForkSource[] = [];
  if (checkpoint.preCompaction.sessionId) {
    const preLeafId = checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId;
    sources.push({
      sessionId: checkpoint.preCompaction.sessionId,
      ...(preLeafId ? { leafId: preLeafId } : {}),
      ...(typeof checkpoint.tokensBefore === "number"
        ? { totalTokens: checkpoint.tokensBefore }
        : {}),
    });
  }

  const postLeafId = checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId;
  if (checkpoint.postCompaction.sessionId && postLeafId) {
    sources.push({
      sessionId: checkpoint.postCompaction.sessionId,
      leafId: postLeafId,
      ...(typeof checkpoint.tokensAfter === "number"
        ? { totalTokens: checkpoint.tokensAfter }
        : {}),
    });
  }

  return sources;
}

function readSqliteTranscriptRowsForFork(
  database: OpenClawAgentDatabase,
  source: { sessionId: string; leafId?: string },
): { status: "created"; events: TranscriptEvent[] } | { status: "missing-boundary" | "failed" } {
  const boundarySeq = source.leafId
    ? readTranscriptIdentityByEventId(database, source.sessionId, source.leafId)?.seq
    : undefined;
  if (source.leafId && boundarySeq === undefined) {
    return { status: "missing-boundary" };
  }

  const db = getSessionKysely(database.db);
  const query = db
    .selectFrom("transcript_events")
    .select(["event_json", "seq"])
    .where("session_id", "=", source.sessionId)
    .orderBy("seq", "asc");
  const rows = executeSqliteQuerySync(
    database.db,
    boundarySeq === undefined ? query : query.where("seq", "<=", boundarySeq),
  ).rows;
  if (rows.length === 0) {
    return { status: "failed" };
  }
  try {
    return {
      status: "created",
      events: rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent),
    };
  } catch {
    return { status: "failed" };
  }
}

function readSessionCompactionCheckpoint(
  entry: Pick<SessionEntry, "compactionCheckpoints">,
  checkpointId: string,
): SessionCompactionCheckpoint | undefined {
  const normalizedCheckpointId = checkpointId.trim();
  if (!normalizedCheckpointId || !Array.isArray(entry.compactionCheckpoints)) {
    return undefined;
  }
  return entry.compactionCheckpoints.find(
    (checkpoint) => checkpoint.checkpointId === normalizedCheckpointId,
  );
}

function cloneSqliteCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  const hasTotalTokens =
    typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens);
  return {
    ...params.currentEntry,
    sessionId: params.nextSessionId,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens: hasTotalTokens ? params.totalTokens : undefined,
    totalTokensFresh: hasTotalTokens ? true : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const header = events.find(isSessionTranscriptHeader) as { cwd?: unknown } | undefined;
  return typeof header?.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
}

function isSessionTranscriptHeader(event: TranscriptEvent): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    (event as { type?: unknown }).type === "session",
  );
}

/** Records inbound session metadata without refreshing activity timestamps. */
