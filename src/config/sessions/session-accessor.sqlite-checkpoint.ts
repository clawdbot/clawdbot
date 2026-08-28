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
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  formatSqliteSessionReferenceForScope,
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
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
  type SessionCompactionCheckpoint,
} from "./types.js";

// Compaction checkpoint branch/restore owner.

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

type SqliteCompactionCheckpointLegacySource = {
  checkpointId: string;
  events: TranscriptEvent[];
  sessionFile: string;
  sourceLeafId?: string;
  totalTokens?: number;
};

type SessionEntryExpectedState = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;

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
  | { status: "model-selection-locked" }
  | { status: "conflict" }
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
  expectedState: SessionEntryExpectedState;
  legacySource?: SqliteCompactionCheckpointLegacySource;
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
  expectedState: SessionEntryExpectedState;
  legacySource?: SqliteCompactionCheckpointLegacySource;
};

type SqliteCompactionCheckpointSessionOperation =
  | ({ kind: "branch" } & SqliteBranchCheckpointSessionParams)
  | ({ kind: "restore" } & SqliteRestoreCheckpointSessionParams);

export async function branchCompactionCheckpointSession(
  params: SqliteBranchCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  return await applySqliteCompactionCheckpointSessionOperation({ ...params, kind: "branch" });
}

export async function restoreCompactionCheckpointSession(
  params: SqliteRestoreCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  return await applySqliteCompactionCheckpointSessionOperation({ ...params, kind: "restore" });
}

async function applySqliteCompactionCheckpointSessionOperation(
  operation: SqliteCompactionCheckpointSessionOperation,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sourceKey = normalizeSqliteSessionKey(
    operation.kind === "branch"
      ? (operation.sourceStoreKey ?? operation.sourceKey)
      : (operation.sessionStoreKey ?? operation.sessionKey),
  );
  const targetKey = normalizeSqliteSessionKey(
    operation.kind === "branch" ? operation.nextKey : operation.sessionKey,
  );
  const resolved = resolveSqliteScope({
    ...(operation.agentId ? { agentId: operation.agentId } : {}),
    ...(operation.env ? { env: operation.env } : {}),
    sessionKey: sourceKey,
    ...(operation.storePath ? { storePath: operation.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const committed = runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sourceKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      const previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
      const result = applySqliteCompactionCheckpointSessionOperationInTransaction(
        database,
        resolved,
        operation,
        sourceKey,
        targetKey,
      );
      return {
        previousIdentity,
        currentIdentity: readSessionIdentitySnapshot(database, identityKeys),
        result,
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(committed.previousIdentity, committed.currentIdentity);
    return committed.result;
  });
}

function applySqliteCompactionCheckpointSessionOperationInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  operation: SqliteCompactionCheckpointSessionOperation,
  sourceKey: string,
  targetKey: string,
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  if (
    currentEntry.sessionId !== operation.expectedState.sessionId ||
    currentEntry.lifecycleRevision !== operation.expectedState.lifecycleRevision
  ) {
    return { status: "conflict" };
  }
  if (currentEntry.modelSelectionLocked === true) {
    return { status: "model-selection-locked" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, operation.checkpointId);
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const forked = forkSqliteCheckpointTranscriptInTransaction(database, resolved, {
    checkpoint,
    legacySource: operation.legacySource,
    targetSessionKey: targetKey,
  });
  if (forked.status !== "created") {
    return forked;
  }

  const nextEntry =
    operation.kind === "branch"
      ? cloneSqliteCheckpointSessionEntry({
          currentEntry,
          creation: operation.creation,
          label: currentEntry.label?.trim()
            ? `${currentEntry.label.trim()} (checkpoint)`
            : "Checkpoint branch",
          nextSessionId: forked.sessionId,
          parentSessionKey: normalizeSqliteSessionKey(operation.sourceKey),
          totalTokens: forked.totalTokens,
        })
      : cloneSqliteCheckpointSessionEntry({
          currentEntry,
          nextSessionId: forked.sessionId,
          preserveCompactionCheckpoints: true,
          totalTokens: forked.totalTokens,
        });
  writeSessionEntry(database, targetKey, nextEntry);
  return {
    status: "created",
    key: targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function forkSqliteCheckpointTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    checkpoint: SessionCompactionCheckpoint;
    legacySource?: SqliteCompactionCheckpointLegacySource;
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
  const legacySource = selected
    ? undefined
    : resolvePreparedLegacyCheckpointSource(params.checkpoint, params.legacySource);
  if (!selected && !legacySource) {
    return lastFailure;
  }

  const sessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: params.targetSessionKey,
  };
  const sessionFile = formatSqliteSessionReferenceForScope(targetScope);
  const selectedEvents = selected?.rows ?? legacySource?.events ?? [];
  const totalTokens = selected?.source.totalTokens ?? legacySource?.totalTokens;
  appendTranscriptEventsInTransaction(database, targetScope, [
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selectedEvents),
      sessionId,
    }),
    ...selectedEvents.filter((event) => !isSessionTranscriptHeader(event)),
  ]);
  return {
    status: "created",
    sessionId,
    sessionFile,
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
  };
}

function resolvePreparedLegacyCheckpointSource(
  checkpoint: SessionCompactionCheckpoint,
  source: SqliteCompactionCheckpointLegacySource | undefined,
): SqliteCompactionCheckpointLegacySource | undefined {
  if (!source || source.checkpointId !== checkpoint.checkpointId || source.events.length === 0) {
    return undefined;
  }
  const matches = [checkpoint.preCompaction, checkpoint.postCompaction].some((position) => {
    const sessionFile = position.sessionFile?.trim();
    const sourceLeafId = position.entryId?.trim() || position.leafId?.trim() || undefined;
    return sessionFile === source.sessionFile && sourceLeafId === source.sourceLeafId;
  });
  return matches ? source : undefined;
}

function resolveSqliteCheckpointTranscriptForkSources(
  checkpoint: SessionCompactionCheckpoint,
): SqliteCheckpointTranscriptForkSource[] {
  const sources: SqliteCheckpointTranscriptForkSource[] = [];
  const checkpointTokensTrusted = checkpoint.tokensVersion === SESSION_TOTAL_TOKENS_VERSION;
  if (checkpoint.preCompaction.sessionId) {
    const preLeafId = checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId;
    sources.push({
      sessionId: checkpoint.preCompaction.sessionId,
      ...(preLeafId ? { leafId: preLeafId } : {}),
      ...(checkpointTokensTrusted && typeof checkpoint.tokensBefore === "number"
        ? { totalTokens: checkpoint.tokensBefore }
        : {}),
    });
  }

  const postLeafId = checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId;
  if (checkpoint.postCompaction.sessionId && postLeafId) {
    sources.push({
      sessionId: checkpoint.postCompaction.sessionId,
      leafId: postLeafId,
      ...(checkpointTokensTrusted && typeof checkpoint.tokensAfter === "number"
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
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
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
    // A new branch belongs to its requester, including an explicitly absent
    // sandbox floor. Restore and actorless branches retain the source stamp.
    ...(params.creation
      ? {
          ...buildSessionCreationStamp(params.creation),
          createdActor: params.creation.actor,
          sandbox: params.creation.sandbox,
        }
      : {}),
    sessionId: params.nextSessionId,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    lifecycleRunId: undefined,
    lastRunId: undefined,
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
    totalTokensVersion: hasTotalTokens ? SESSION_TOTAL_TOKENS_VERSION : undefined,
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
