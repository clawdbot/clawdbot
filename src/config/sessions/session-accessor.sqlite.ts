import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql, type Selectable } from "kysely";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { derivePromptTokens, normalizeUsage } from "../../agents/usage.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import { redactSecrets } from "../../logging/redact.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type {
  ExactSessionEntry,
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  LatestTranscriptAssistantMessage,
  LatestTranscriptMessage,
  LatestTranscriptAssistantText,
  SessionLifecycleArchivedTranscript,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  DeletedAgentSessionEntryPurgeParams,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionAccessScope,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntrySummary,
  SessionEntryTargetPatchScope,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionEntryUpdateOptions,
  SessionTranscriptAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptStats,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  SessionParentForkDecision,
  TranscriptEvent,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import {
  foldedSessionKeyAliasCandidates,
  normalizeStoreSessionKey,
  resolveSessionStoreEntry,
} from "./store-entry.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldPreserveMaintenanceEntry,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type {
  ResetSessionEntryLifecycleMutation,
  SessionArchivedTranscriptCleanupRule,
} from "./store.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { serializeJsonlLines } from "./transcript-jsonl.js";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  parseSessionTranscriptTreeEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import { resolveVisibleTranscriptAppendParentId } from "./transcript-visible-events.js";
import type { GroupKeyResolution, SessionCompactionCheckpoint, SessionEntry } from "./types.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  resolveFreshSessionTotalTokens,
  resolveSessionTotalTokens,
} from "./types.js";

type SessionArchiveRuntime = typeof import("../../gateway/session-archive.runtime.js");
let sessionArchiveRuntimePromise: Promise<SessionArchiveRuntime> | undefined;
const SQLITE_SESSION_SLOW_WRITE_MS = 1_000;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "conversations"
  | "session_conversations"
  | "session_entries"
  | "session_routes"
  | "sessions"
  | "trajectory_runtime_events"
  | "transcript_event_identities"
  | "transcript_events"
>;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_entries"]>;
type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntrySelectionSnapshot = {
  selected: ResolvedSessionEntryRow | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteSessionStateDeletePlan = {
  archiveDirectory: string;
  archiveTranscript: boolean;
  content: string;
  hadTranscriptState: boolean;
  reason: "deleted" | "reset";
  sessionId: string;
};
type SqliteSessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
type SqliteSessionEntryMaintenancePlan = {
  entryRemovals: SqliteSessionEntryRemovalPlan[];
  stateDeletePlans: SqliteSessionStateDeletePlan[];
};
type MaterializedSqliteSessionStateDeletePlan = SqliteSessionStateDeletePlan & {
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};
type SqliteLifecycleArtifactCleanupPlan = {
  deletePlans: SqliteSessionStateDeletePlan[];
  entries: SqliteSessionEntryRemovalPlan[];
};
type SqliteProjectedLifecycleMutation = {
  deletePlans: SqliteSessionStateDeletePlan[];
  removals: Array<{
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    sessionKey: string;
  }>;
};
type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
};

class SqliteSessionMutationConflictError extends Error {
  constructor(operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

type ResolvedSqliteScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

type ResolvedSqliteReadScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey?: string;
};

type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

type SqliteParentForkSourceTranscript = {
  appendMode?: "side";
  appendParentId: string | null;
  branchEntries: TranscriptEvent[];
  cwd?: string;
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  leafId: string | null;
  preserveLeafControl: boolean;
};

type SqliteTranscriptParentTokenEstimate = {
  kind: "exact-context" | "legacy-or-bytes";
  tokens: number;
};

/** Result from SQLite compaction checkpoint branch or restore operations. */
export type SqliteCompactionCheckpointSessionMutationResult =
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
export type SqliteBranchCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
export type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
};

/** Internal doctor/migration import target for one legacy session row. */
export type SqliteSessionImportRowsParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  entry: SessionEntry;
  readTranscriptEvents?: (append: (event: TranscriptEvent) => void) => void;
};

/** Summary of rows written by an internal doctor/migration import. */
export type SqliteSessionImportRowsResult = {
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

export type SqliteExpectedSessionTranscriptTurnResult = {
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SqliteTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

const SQLITE_SESSION_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

/** Loads one session entry from the additive SQLite session store. */
export function loadSqliteSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntryRow(database, resolved.sessionKey)?.entry;
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSqliteSessionEntry(
  scope: SessionAccessScope,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readExactSessionEntryRow(database, sessionKey);
  return row ? { sessionKey, entry: row.entry } : undefined;
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSqliteSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("session_key")
      .where("session_id", "=", resolved.sessionId)
      .orderBy("updated_at", "desc")
      .orderBy("session_key", "asc")
      .limit(1),
  );
  return row?.session_key;
}

/** Lists session entries from the additive SQLite session store. */
export function listSqliteSessionEntries(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json", "session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;
  return rows
    .map((row) => {
      if (isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const entry = parseSessionEntryRow(row);
      return entry ? { sessionKey: row.session_key, entry } : undefined;
    })
    .filter((entry): entry is SessionEntrySummary => entry !== undefined);
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSqliteSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? normalizeSqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSqliteSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => patch, {
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSqliteSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSqliteSessionEntrySync(
  scope: SessionAccessScope,
  entry: SessionEntry,
): void {
  const resolved = resolveSqliteScope(scope);
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, resolved.sessionKey, entry);
  }, toDatabaseOptions(resolved));
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteSessionEntrySelectionSnapshot(
      database,
      resolved.sessionKey,
      options.replaceEntry === true,
    );
    const writeBase = prepared.selected?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.selected?.entry
        ? cloneSessionEntry(prepared.selected.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        options.replaceEntry === true,
      );
      assertSqliteSessionEntrySelectionUnchanged(prepared, fresh, "session-entry.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: resolved.sessionKey,
          });
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(
        writeDatabase,
        fresh.selected?.legacyKeys ?? [],
        resolved.sessionKey,
      );
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: resolved.sessionKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

/** Patches one logical entry selected from a canonical key and alias set. */
export async function patchSqliteSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteStoreScope(scope.storePath, { agentId: scope.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteLifecycleTargetSnapshot(database, scope.target);
    const writeBase = prepared.primary?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.primary?.entry
        ? cloneSessionEntry(prepared.primary.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteLifecycleTargetSnapshot(writeDatabase, scope.target);
      assertSqliteLifecycleTargetSnapshotUnchanged(prepared, fresh, "session-entry-target.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: scope.target.canonicalKey,
          });
      deleteSqliteLifecycleTargetRows(writeDatabase, scope.target);
      writeSessionEntry(writeDatabase, scope.target.canonicalKey, next);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: scope.target.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

/** Forks one parent SQLite transcript into a new child transcript. */
export async function forkSqliteSessionTranscriptFromParent(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const target = params.targetStorePath
    ? resolveSqliteScope({ sessionKey: params.sessionKey, storePath: params.targetStorePath })
    : resolved;
  const crossDatabase =
    target.agentId !== resolved.agentId || (target.path ?? "") !== (resolved.path ?? "");
  if (!crossDatabase) {
    return await runExclusiveSqliteSessionWrite(resolved, async () => {
      let result: ForkSessionFromParentTranscriptResult = { status: "failed" };
      runOpenClawAgentWriteTransaction((database) => {
        result = forkSqliteParentTranscriptInTransaction(database, resolved, {
          parentEntry: params.parentEntry,
          parentSessionKey: params.parentSessionKey,
          targetSessionId: params.targetSessionId,
          targetSessionKey: params.sessionKey,
        });
      }, toDatabaseOptions(resolved));
      return result;
    });
  }
  // Cross-agent fork (worktree/cross-agent sessions.create): parent rows live
  // in the source agent database while the child transcript must be owned by
  // the target agent's database. Two databases cannot share one transaction,
  // so read the parent branch first, then write the child under the target's
  // exclusive session write lock.
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const source = readSqliteParentForkSourceTranscript(sourceDatabase, params.parentEntry.sessionId);
  if (!source) {
    return { status: "failed" };
  }
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  return await runExclusiveSqliteSessionWrite(target, async () => {
    const sessionId = params.targetSessionId ?? randomUUID();
    const targetScope = {
      ...target,
      sessionId,
      sessionKey: normalizeSqliteSessionKey(params.sessionKey),
    };
    const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
    runOpenClawAgentWriteTransaction((database) => {
      writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
        parentSessionFile,
        source,
      });
    }, toDatabaseOptions(target));
    return { status: "created", transcript: { sessionFile, sessionId } };
  });
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSqliteSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const parentTarget = normalizeSqliteLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeSqliteLifecycleTarget(params.sessionTarget);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const parent = resolveSqliteLifecyclePrimaryEntry(database, parentTarget);
    if (!parent?.entry.sessionId) {
      return { status: "missing-parent" };
    }

    const existing = resolveSqliteLifecyclePrimaryEntry(database, sessionTarget);
    const base = existing?.entry ?? params.fallbackEntry;
    if (!base) {
      return { status: "missing-entry" };
    }

    if (params.skipForkWhen?.(cloneSessionEntry(base))) {
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch: params.skipPatch?.(cloneSessionEntry(base)),
        resolved,
      });
      return {
        status: "skipped",
        reason: "existing-entry",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
      };
    }

    const needsTranscriptTokenEstimate =
      typeof resolveFreshSessionTotalTokens(parent.entry) !== "number" &&
      typeof parent.entry.sessionId === "string" &&
      parent.entry.sessionId.length > 0;
    const transcriptParentTokens = needsTranscriptTokenEstimate
      ? estimateSqliteTranscriptPromptTokens(
          loadSqliteTranscriptEventsFromDatabase(database, parent.entry.sessionId),
        )
      : undefined;
    const decision = resolveSqliteParentForkDecision(parent.entry, transcriptParentTokens);
    if (decision.status === "skip") {
      const patch = params.decisionSkipPatch?.({
        decision,
        entry: cloneSessionEntry(base),
        parentEntry: cloneSessionEntry(parent.entry),
      });
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch,
        resolved,
      });
      return {
        status: "skipped",
        reason: "decision-skip",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
        decision,
      };
    }

    let result: ForkSessionEntryFromParentTargetResult = { status: "failed" };
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const freshParent = resolveSqliteLifecyclePrimaryEntry(writeDatabase, parentTarget)?.entry;
      if (!freshParent?.sessionId) {
        result = { status: "missing-parent" };
        return;
      }
      const freshExisting = resolveSqliteLifecyclePrimaryEntry(writeDatabase, sessionTarget);
      const freshBase = freshExisting?.entry ?? params.fallbackEntry;
      if (!freshBase) {
        result = { status: "missing-entry" };
        return;
      }
      const fork = forkSqliteParentTranscriptInTransaction(writeDatabase, resolved, {
        parentEntry: freshParent,
        parentSessionKey: parentTarget.canonicalKey,
        targetSessionKey: sessionTarget.canonicalKey,
      });
      if (fork.status !== "created") {
        result =
          fork.status === "missing-parent" ? { status: "missing-parent" } : { status: "failed" };
        return;
      }
      const patch = params.patch?.({
        decision,
        entry: cloneSessionEntry(freshBase),
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
      });
      const next = mergeSessionEntry(freshBase, {
        ...patch,
        forkedFromParent: true,
        sessionFile: fork.transcript.sessionFile,
        sessionId: fork.transcript.sessionId,
      });
      deleteSqliteLifecycleTargetRows(writeDatabase, sessionTarget);
      writeSessionEntry(writeDatabase, sessionTarget.canonicalKey, next);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: sessionTarget.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          skipMaintenance: true,
        }),
      );
      result = {
        status: "forked",
        decision,
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
        sessionEntry: cloneSessionEntry(next),
      };
    }, toDatabaseOptions(resolved));
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

async function persistSqliteParentForkSkipPatch(params: {
  entry: SessionEntry;
  params: ForkSessionEntryFromParentTargetParams;
  sessionTarget: { canonicalKey: string; storeKeys: string[] };
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): Promise<SessionEntry> {
  if (!params.patch) {
    return cloneSessionEntry(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionTarget.canonicalKey,
  });
  const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
  runOpenClawAgentWriteTransaction((database) => {
    deleteSqliteLifecycleTargetRows(database, params.sessionTarget);
    writeSessionEntry(database, params.sessionTarget.canonicalKey, next);
    maintenancePlans.push(
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: params.sessionTarget.canonicalKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(params.resolved),
        skipMaintenance: true,
      }),
    );
  }, toDatabaseOptions(params.resolved));
  finalizeSqliteSessionEntryMaintenancePlansBestEffort(params.resolved, maintenancePlans);
  return cloneSessionEntry(next);
}

/** Updates an existing entry in the additive SQLite session store. */
export async function updateSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteSessionEntrySelectionSnapshot(database, resolved.sessionKey, false);
    const writeBase = prepared.selected?.entry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase));
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        false,
      );
      assertSqliteSessionEntrySelectionUnchanged(prepared, fresh, "session-entry.update");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const merged = mergeSessionEntry(writeBase, patch);
      const next = preserveSqliteSameKeySessionRolloverLineage({
        next: merged,
        previous: writeBase,
        sessionKey: resolved.sessionKey,
      });
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(
        writeDatabase,
        fresh.selected?.legacyKeys ?? [],
        resolved.sessionKey,
      );
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: resolved.sessionKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          skipMaintenance: options.skipMaintenance,
        }),
      );
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

/** Cleans scoped session lifecycle rows and associated SQLite transcript state. */
export async function cleanupSqliteSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = resolveSqliteReadScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const cleanupPlan = planSqliteSessionLifecycleArtifactCleanup(database, {
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      sessionKeySegmentPrefix,
      transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs ?? Date.now(),
    });
    const materializedPlans = materializeSqliteSessionStateDeletePlans(cleanupPlan.deletePlans);
    let removedEntries = 0;
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      removedEntries = deletePlannedSqliteLifecycleArtifactEntries(
        transactionDb,
        cleanupPlan.entries,
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    return {
      removedEntries,
      archivedTranscriptArtifacts: archivedTranscripts.length,
    };
  });
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSqliteSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const current = resolveSqliteLifecyclePrimaryEntry(database, params.target);
    const nextEntry = await params.buildNextEntry({
      currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
      primaryKey: params.target.canonicalKey,
    });
    const mutation: ResetSessionEntryLifecycleMutation = {
      nextEntry: cloneSessionEntry(nextEntry),
      ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
      ...(current?.entry.sessionFile ? { previousSessionFile: current.entry.sessionFile } : {}),
      ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
    };
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const referencedAfterReset = current?.entry.sessionId
      ? readReferencedSqliteSessionIdsAfterTargetMutation(database, params.target, nextEntry)
      : new Set<string>();
    const deletePlans = current?.entry.sessionId
      ? planSqliteSessionStateAfterEntryRemoval({
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          database,
          entry: current.entry,
          reason: "reset",
          referencedSessionIds: referencedAfterReset,
        })
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      assertSqliteLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    await params.afterEntryMutation?.(mutation);
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      ...mutation,
      archivedTranscripts,
    };
  });
}

const MODEL_SELECTION_LOCK_REMOVAL_MESSAGE =
  "Model-selection-locked sessions cannot be removed, unlocked, or reassigned.";

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
): Promise<DeleteSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: DeleteSessionEntryLifecycleResult = {
      archivedTranscripts: [],
      deleted: false,
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const current = resolveSqliteLifecyclePrimaryEntry(database, params.target);
    if (!current) {
      return result;
    }
    if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    const referencedAfterDelete = readReferencedSqliteSessionIdsAfterTargetMutation(
      database,
      params.target,
    );
    const deletePlans = params.archiveTranscript
      ? planSqliteSessionStateAfterEntryRemoval({
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          archiveTranscript: true,
          database,
          entry: current.entry,
          reason: "deleted",
          referencedSessionIds: referencedAfterDelete,
        })
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const transactionEntry = resolveSqliteLifecyclePrimaryEntry(
        transactionDb,
        params.target,
      )?.entry;
      if (
        !sqliteSessionEntriesEqual(transactionEntry, current.entry) ||
        !shouldDeleteSqliteSessionEntryLifecycle(transactionEntry, params)
      ) {
        return;
      }
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      const archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
      result = {
        archivedTranscripts,
        deleted: true,
        deletedEntry: cloneSessionEntry(current.entry),
        ...(current.entry.sessionFile ? { deletedSessionFile: current.entry.sessionFile } : {}),
        ...(current.entry.sessionId ? { deletedSessionId: current.entry.sessionId } : {}),
      };
    }, toDatabaseOptions(resolved));
    emitArchivedSqliteTranscriptUpdates(result.archivedTranscripts);
    return result;
  });
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSqliteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycleInternal(params, false);
}

/** Rolls back one exact locked row created by failed trusted harness initialization. */
export async function rollbackSqliteAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  const hasExactTarget =
    params.target.storeKeys.length === 1 &&
    params.target.storeKeys[0] === params.target.canonicalKey;
  const expectedEntryError = resolveAgentHarnessSessionStoreEntryError(
    params.target.canonicalKey,
    params.expectedEntry,
  );
  if (
    !hasExactTarget ||
    expectedEntryError ||
    !isValidAgentHarnessSessionStoreEntry(params.target.canonicalKey, params.expectedEntry)
  ) {
    throw new Error(expectedEntryError ?? MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true);
}

/** Rolls back one exact locked CLI row created by a failed plugin initializer. */
export async function rollbackSqlitePluginOwnedSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & {
    expectedEntry: SessionEntry;
    expectedPluginOwnerId: string;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  const hasExactTarget =
    params.target.storeKeys.length === 1 &&
    params.target.storeKeys[0] === params.target.canonicalKey;
  const expectedEntry = params.expectedEntry;
  const validPluginOwner = normalizeOptionalString(expectedEntry.pluginOwnerId);
  const expectedPluginOwner = normalizeOptionalString(params.expectedPluginOwnerId);
  if (
    !hasExactTarget ||
    isAgentHarnessSessionKey(params.target.canonicalKey) ||
    expectedEntry.agentHarnessId !== undefined ||
    expectedEntry.modelSelectionLocked !== true ||
    !validPluginOwner ||
    validPluginOwner !== expectedPluginOwner
  ) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true);
}

/** Applies prepared full-row replacements in one validated SQLite transaction. */
export async function applySqliteSessionEntryReplacements<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSqliteSessionEntryStore(database);
    const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
    const entries = selectedKeys
      ? [...selectedKeys].flatMap((sessionKey) => {
          const entry = store[sessionKey];
          return entry ? [{ entry: cloneSessionEntry(entry), sessionKey }] : [];
        })
      : Object.entries(store).map(([sessionKey, entry]) => ({
          entry: cloneSessionEntry(entry),
          sessionKey,
        }));
    const operation = await params.update(
      entries.map(({ entry, sessionKey }) => ({
        entry: cloneSessionEntry(entry),
        sessionKey,
      })),
    );
    const replacements = [...(operation.replacements ?? [])];
    for (const replacement of replacements) {
      if (selectedKeys && !selectedKeys.has(replacement.sessionKey)) {
        throw new Error(
          `Session entry replacement is outside the selected key set: ${replacement.sessionKey}`,
        );
      }
    }

    const expectedEntries = new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
    const applicable = replacements.filter((replacement) =>
      expectedEntries.has(replacement.sessionKey),
    );
    if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
      throw new Error("session entry replacements did not persist any rows");
    }
    if (applicable.length === 0) {
      return operation.result;
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        for (const replacement of applicable) {
          const current = readExactSessionEntryRow(transactionDb, replacement.sessionKey)?.entry;
          if (!sqliteSessionEntriesEqual(current, expectedEntries.get(replacement.sessionKey))) {
            throw new Error(
              `SQLite session entry changed before replacement for ${replacement.sessionKey}`,
            );
          }
        }
        for (const replacement of applicable) {
          writeSessionEntry(
            transactionDb,
            replacement.sessionKey,
            cloneSessionEntry(replacement.entry),
          );
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance ?? true,
          }),
        );
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.entry-replacements" },
    );
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return operation.result;
  });
}

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySqliteSessionEntryLifecycleMutation(params: {
  agentId?: string;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const removals = [...(params.removals ?? [])];
    const upserts = [...(params.upserts ?? [])];
    const removedSessionKeys: string[] = [];
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let artifactCleanupError: unknown;
    const captureArtifactCleanupError = (error: unknown): void => {
      if (params.captureArtifactCleanupError === true) {
        artifactCleanupError ??= error;
        return;
      }
      throw error;
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const projected = await projectSqliteSessionEntryLifecycleMutation(database, {
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      removals,
      upserts,
    });
    let materializedRemovalPlans: MaterializedSqliteSessionStateDeletePlan[] = [];
    try {
      materializedRemovalPlans = materializeSqliteSessionStateDeletePlans(projected.deletePlans);
    } catch (error) {
      captureArtifactCleanupError(error);
    }
    runOpenClawAgentWriteTransaction((transactionDb) => {
      for (const removal of projected.removals) {
        const entry = readExactSessionEntryRow(transactionDb, removal.sessionKey)?.entry;
        if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
          throw new Error(
            `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
          );
        }
        if (!shouldRemoveSqliteSessionEntry(entry, removal.removal)) {
          continue;
        }
        deleteSqliteSessionEntryRows(transactionDb, removal.sessionKey);
        removedSessionKeys.push(removal.sessionKey);
      }
      for (const { sessionKey, entry, expectedEntry } of projected.upsertedEntries) {
        const currentEntry = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
        if (!sqliteSessionEntriesEqual(currentEntry, expectedEntry)) {
          throw new Error(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
        }
        writeSessionEntry(transactionDb, sessionKey, entry);
      }
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: params.activeSessionKey ?? "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          forceMaintenance: params.maintenanceOverride !== undefined,
          maintenanceConfig: params.maintenanceOverride
            ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
            : undefined,
          skipMaintenance: params.skipMaintenance,
        }),
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedRemovalPlans,
      );
    }, toDatabaseOptions(resolved));
    const maintenanceArchivedTranscripts = finalizeSqliteSessionEntryMaintenancePlansBestEffort(
      resolved,
      maintenancePlans,
    );
    archivedTranscripts = [...archivedTranscripts, ...maintenanceArchivedTranscripts];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    const archivedTranscriptDirectories = uniqueStrings(
      archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
    ).toSorted();
    if (archivedTranscriptDirectories.length > 0 && params.cleanupArchivedTranscripts) {
      try {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        await cleanupArchivedSessionTranscripts({
          directories: archivedTranscriptDirectories,
          rules: params.cleanupArchivedTranscripts.rules,
          nowMs: params.cleanupArchivedTranscripts.nowMs,
        });
      } catch (error) {
        captureArtifactCleanupError(error);
      }
    }
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories,
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
      artifactCleanupError,
    };
  });
}

/** Purges entries owned by a deleted agent from SQLite session rows. */
export async function purgeSqliteDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.storeAgentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSqliteSessionEntryStore(database);
    const remainingStore = { ...store };
    const entryRemovals: SqliteSessionEntryRemovalPlan[] = [];
    const removedEntriesToArchive: SessionEntry[] = [];
    for (const sessionKey of Object.keys(store)) {
      const ownerAgentId = resolveStoredSessionOwnerAgentId({
        cfg: params.cfg,
        agentId: params.storeAgentId,
        sessionKey,
      });
      if (ownerAgentId !== params.agentId) {
        continue;
      }
      const entry = store[sessionKey];
      entryRemovals.push({ expectedEntry: cloneSessionEntry(entry), sessionKey });
      removedEntriesToArchive.push(entry);
      delete remainingStore[sessionKey];
    }
    const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
      database,
      excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
      projectedStore: remainingStore,
    });
    const deletePlans = removedEntriesToArchive.flatMap((entry) =>
      planSqliteSessionStateAfterEntryRemoval({
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        database,
        entry,
        reason: "deleted",
        referencedSessionIds,
      }),
    );
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    const removedSessionKeys = entryRemovals.map((removal) => removal.sessionKey);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      deletePlannedSqliteLifecycleArtifactEntries(transactionDb, entryRemovals);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        }),
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    archivedTranscripts = [
      ...archivedTranscripts,
      ...finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans),
    ];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories: uniqueStrings(
        archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
      ).toSorted(),
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
    };
  });
}

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadSqliteTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadSqliteTranscriptEventsSync(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return loadSqliteTranscriptEventsFromDatabase(database, resolved.sessionId);
}

function loadSqliteTranscriptEventsFromDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
): TranscriptEvent[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

function sqliteTranscriptJsonlByteSize() {
  return /* kysely-allow-raw: JSONL size includes event bytes plus newline separators. */ sql<number>`COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0)
    + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END`.as("size_bytes");
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readSqliteTranscriptStatsSync(
  scope: SessionTranscriptReadScope,
): SessionTranscriptStats {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.count<number>("seq").as("event_count"),
        eb.fn.max<number>("seq").as("max_seq"),
        sqliteTranscriptJsonlByteSize(),
      ])
      .where("session_id", "=", resolved.sessionId),
  );
  return {
    eventCount: row?.event_count ?? 0,
    maxSeq: row?.max_seq ?? 0,
    sizeBytes: row?.size_bytes ?? 0,
  };
}

function readTranscriptEventJsonSetInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("event_json").where("session_id", "=", sessionId),
  ).rows;
  return new Set(rows.map((row) => row.event_json));
}

/** Reads the latest visible assistant text from SQLite transcript rows in reverse order. */
export function loadLatestSqliteAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as te")
      .innerJoin("transcript_event_identities as ti", (join) =>
        join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
      )
      .select("te.event_json as event_json")
      .where("te.session_id", "=", resolved.sessionId)
      .where("ti.event_type", "=", "message")
      .orderBy("te.seq", "desc"),
  );
  for (const row of rows) {
    const latest = parseLatestAssistantMessageEvent(row.event_json, options);
    if (!latest) {
      continue;
    }
    const text = parseLatestAssistantText(latest);
    if (text) {
      return text;
    }
  }
  return undefined;
}

/** Reads the latest assistant message payload from SQLite transcript rows in reverse order. */
export function loadLatestSqliteAssistantMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as te")
      .innerJoin("transcript_event_identities as ti", (join) =>
        join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
      )
      .select("te.event_json as event_json")
      .where("te.session_id", "=", resolved.sessionId)
      .where("ti.event_type", "=", "message")
      .orderBy("te.seq", "desc"),
  );
  for (const row of rows) {
    const latest = parseLatestAssistantMessageEvent(row.event_json, options);
    if (latest) {
      return latest;
    }
  }
  return undefined;
}

/** Reads the newest transcript message payload from SQLite transcript rows. */
export function loadLatestSqliteMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptMessage | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events as te")
      .innerJoin("transcript_event_identities as ti", (join) =>
        join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
      )
      .select("te.event_json as event_json")
      .where("te.session_id", "=", resolved.sessionId)
      .where("ti.event_type", "=", "message")
      .orderBy("te.seq", "desc")
      .limit(1),
  );
  return row ? parseLatestMessageEvent(row.event_json, options) : undefined;
}

function parseLatestAssistantText(
  latest: LatestTranscriptAssistantMessage,
): LatestTranscriptAssistantText | undefined {
  const message = latest.message as {
    timestamp?: unknown;
  };
  const text = extractAssistantVisibleText(latest.message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(latest.id ? { id: latest.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function parseLatestAssistantMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: {
      model?: unknown;
      provider?: unknown;
      role?: unknown;
      timestamp?: unknown;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

function parseLatestMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: {
      model?: unknown;
      provider?: unknown;
      role?: unknown;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || typeof message.role !== "string") {
    return undefined;
  }
  if (
    message.role === "assistant" &&
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

/** Checks whether the additive SQLite transcript store has rows for a transcript. */
export function sqliteTranscriptExists(scope: SessionTranscriptReadScope): boolean {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", resolved.sessionId)
      .limit(1),
  );
  return row !== undefined;
}

/** Deletes rows for one transcript from the additive SQLite transcript store. */
export async function deleteSqliteTranscript(scope: SessionTranscriptReadScope): Promise<boolean> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let deleted = false;
    runOpenClawAgentWriteTransaction((database) => {
      deleted = deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
    }, toDatabaseOptions(resolved));
    return deleted;
  });
}

/** Fully replaces rows for one transcript in the additive SQLite transcript store. */
export async function replaceSqliteTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
    }, toDatabaseOptions(resolved));
  });
}

/** Fully replaces rows for one transcript synchronously for sync session runtimes. */
export function replaceSqliteTranscriptEventsSync(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): boolean {
  const resolved = resolveSqliteTranscriptScope(scope);
  let replaced = false;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
    replaced = true;
  }, toDatabaseOptions(resolved));
  return replaced;
}

/** Imports one legacy session entry and its transcript rows for doctor migration. */
export async function importSqliteSessionRows(
  params: SqliteSessionImportRowsParams,
): Promise<SqliteSessionImportRowsResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: params.sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let transcriptEvents = 0;
    runOpenClawAgentWriteTransaction((database) => {
      const currentEntry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
      const preservedHarnessId =
        params.entry.agentHarnessId === undefined &&
        currentEntry?.sessionId === params.entry.sessionId &&
        currentEntry.lifecycleRevision === params.entry.lifecycleRevision
          ? currentEntry.agentHarnessId?.trim()
          : undefined;
      // Plugin doctor migrations can claim a legacy session before the full
      // session import runs. Preserve that same-generation canonical owner.
      const importedEntry = {
        ...params.entry,
        ...(preservedHarnessId ? { agentHarnessId: preservedHarnessId } : {}),
        sessionFile: formatSqliteSessionMarkerForScope({
          ...resolved,
          sessionId: params.entry.sessionId,
        }),
      };
      writeSessionEntry(database, resolved.sessionKey, importedEntry);
      if (params.readTranscriptEvents) {
        const transcriptScope = {
          ...resolved,
          sessionId: params.entry.sessionId,
        };
        const existingEventJson = readTranscriptEventJsonSetInTransaction(
          database,
          params.entry.sessionId,
        );
        params.readTranscriptEvents((event) => {
          const eventJson = JSON.stringify(event);
          if (existingEventJson.has(eventJson)) {
            return;
          }
          if (appendTranscriptEventInTransaction(database, transcriptScope, event)) {
            existingEventJson.add(eventJson);
            transcriptEvents += 1;
          }
        });
      }
    }, toDatabaseOptions(resolved));
    return {
      sessionId: params.entry.sessionId,
      sessionKey: resolved.sessionKey,
      transcriptEvents,
    };
  });
}

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendSqliteTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventInTransaction(database, resolved, event);
    }, toDatabaseOptions(resolved));
  });
}

/** Appends one raw non-message transcript event synchronously for sync session runtimes. */
export function appendSqliteTranscriptEventSync(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): void {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    appendTranscriptEventInTransaction(database, resolved, event);
  }, toDatabaseOptions(resolved));
}

/** Appends raw transcript events to the additive SQLite transcript store in one transaction. */
export async function appendSqliteTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      for (const event of events) {
        appendTranscriptEventInTransaction(database, resolved, event);
      }
    }, toDatabaseOptions(resolved));
  });
}

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendSqliteExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedLifecycleRevision?: string;
    expectedSessionId: string;
    messages: readonly SessionTranscriptTurnMessageAppend[];
    sessionFile: string;
    touchSessionEntry?: boolean;
  },
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    sessionId: options.expectedSessionId,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const preparedEntry = readSessionEntryRow(database, resolved.sessionKey);
    if (!sqliteSessionMatchesExpectedTranscriptTurn(preparedEntry, options)) {
      return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
    }
    const messages = await selectAppendableSqliteTranscriptTurnMessages(
      {
        agentId: resolved.agentId,
        sessionFile: options.sessionFile,
        sessionId: options.expectedSessionId,
        sessionKey: resolved.sessionKey,
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      },
      options.messages,
    );
    let result: SqliteExpectedSessionTranscriptTurnResult = sqliteSessionTranscriptTurnRebound(
      preparedEntry,
      options.sessionFile,
    );
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const fresh = readSessionEntryRow(transactionDb, resolved.sessionKey);
      if (!sqliteSessionMatchesExpectedTranscriptTurn(fresh, options)) {
        result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
        return;
      }
      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, ...appendOptions } = append;
        const appended = appendSqliteTranscriptMessageInTransaction(transactionDb, resolved, {
          ...appendOptions,
          ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
          ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        });
        if (appended) {
          appendedMessages.push(appended);
        }
      }

      const appendedCount = appendedMessages.filter((message) => message.appended).length;
      const touchUpdatedAt =
        options.touchSessionEntry === true && appendedCount > 0 ? Date.now() : undefined;
      const sessionPatch: Partial<SessionEntry> = {
        ...(fresh.entry.sessionFile === options.sessionFile
          ? {}
          : { sessionFile: options.sessionFile }),
        ...(touchUpdatedAt !== undefined
          ? { updatedAt: Math.max(fresh.entry.updatedAt ?? 0, touchUpdatedAt) }
          : {}),
      };
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(fresh.entry, sessionPatch)
          : fresh.entry;
      if (next !== fresh.entry) {
        writeSessionEntry(transactionDb, resolved.sessionKey, next);
        deleteLegacySessionEntryRows(transactionDb, fresh.legacyKeys, resolved.sessionKey);
      }
      result = {
        appendedMessages,
        sessionEntry: cloneSessionEntry(next),
        sessionFile: options.sessionFile,
      };
    }, toDatabaseOptions(resolved));
    return result;
  });
}

function sqliteSessionMatchesExpectedTranscriptTurn(
  selected: ResolvedSessionEntryRow | undefined,
  expected: { expectedLifecycleRevision?: string; expectedSessionId: string },
): selected is ResolvedSessionEntryRow {
  return Boolean(
    selected &&
    selected.entry.sessionId === expected.expectedSessionId &&
    (expected.expectedLifecycleRevision === undefined ||
      selected.entry.lifecycleRevision === expected.expectedLifecycleRevision),
  );
}

function sqliteSessionTranscriptTurnRebound(
  selected: ResolvedSessionEntryRow | undefined,
  sessionFile: string,
): SqliteExpectedSessionTranscriptTurnResult {
  return {
    appendedMessages: [],
    rejectedReason: "session-rebound",
    sessionEntry: selected?.entry,
    sessionFile,
  };
}

async function selectAppendableSqliteTranscriptTurnMessages(
  context: SessionTranscriptTurnWriteContext,
  messages: readonly SessionTranscriptTurnMessageAppend[],
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selected: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of messages) {
    const shouldAppend = append.shouldAppend ? await append.shouldAppend(context) : true;
    if (shouldAppend) {
      selected.push(append);
    }
  }
  return selected;
}

/** Appends one transcript message to the additive SQLite transcript store. */
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptMessageAppendResult<TMessage> | undefined;
    runOpenClawAgentWriteTransaction((database) => {
      result = appendSqliteTranscriptMessageInTransaction(database, resolved, options);
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendSqliteTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  const resolved = resolveSqliteTranscriptScope(scope);
  let result: TranscriptMessageAppendResult<TMessage> | undefined;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    result = appendSqliteTranscriptMessageInTransaction(database, resolved, options);
  }, toDatabaseOptions(resolved));
  return result;
}

/** Runs read/append transcript work under one SQLite writer-queue critical section. */
export async function withSqliteTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SqliteTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    return await run({
      readEvents: async () => loadSqliteTranscriptEventsFromDatabase(database, resolved.sessionId),
      replaceEvents: async (events) => {
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
        }, toDatabaseOptions(resolved));
      },
      appendMessage: async (options) => {
        let result: TranscriptMessageAppendResult<unknown> | undefined;
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          result = appendSqliteTranscriptMessageInTransaction(writeDatabase, resolved, options);
        }, toDatabaseOptions(resolved));
        return result as TranscriptMessageAppendResult<typeof options.message> | undefined;
      },
    });
  });
}

/** Runs synchronous transcript work under one writer queue and SQLite transaction. */
export async function withSqliteTranscriptWriteTransaction<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: { sessionFile: string }) => T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () =>
    runOpenClawAgentWriteTransaction(
      () => run({ sessionFile: formatSqliteSessionMarkerForScope(resolved) }),
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.batch" },
    ),
  );
}

function appendSqliteTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }

  const prepared = options.prepareMessageAfterIdempotencyCheck
    ? options.prepareMessageAfterIdempotencyCheck(options.message)
    : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  const messageId = options.eventId ?? randomUUID();
  const now = options.now ?? Date.now();
  const finalMessage = redactTranscriptMessageForStorage(prepared, options);
  ensureTranscriptHeader(database, resolved, options.cwd, now);
  const parentId =
    options.parentId === undefined
      ? readActiveTranscriptAppendParentId(database, resolved.sessionId)
      : options.parentId;
  const event = {
    type: "message",
    id: messageId,
    parentId: parentId ?? null,
    timestamp: resolveTimestampMsToIsoString(now),
    message: finalMessage,
  };
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    dedupeByMessageIdempotency:
      options.idempotencyLookup !== "caller-checked" &&
      options.idempotencyLookup !== "scan-assistant",
  });
  if (!appended && idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }
  if (!appended) {
    const existing = readTranscriptMessageByEventId(database, resolved, messageId);
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }
  if (!appended) {
    throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
  }
  return {
    appended: true,
    message: finalMessage,
    messageId,
  };
}

/** Branches a SQLite session from a compaction checkpoint in one queued transaction. */
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
    runOpenClawAgentWriteTransaction((database) => {
      result = branchSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        parentSessionKey: normalizeSqliteSessionKey(params.sourceKey),
        resolved,
        sourceKey,
        targetKey,
      });
    }, toDatabaseOptions(resolved));
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
    runOpenClawAgentWriteTransaction((database) => {
      result = restoreSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        resolved,
        sourceKey: sessionKey,
        targetKey,
      });
    }, toDatabaseOptions(resolved));
    return result ?? { status: "failed" };
  });
}

/** Publishes a transcript update using the SQLite transcript scope target. */
export async function publishSqliteTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  emitSessionTranscriptUpdate({
    ...update,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    target: {
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      sessionKey: resolved.sessionKey,
    },
  });
}

function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

async function runExclusiveSqliteSessionWrite<T>(
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

function resolveSqliteScope(
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

function resolveSqliteReadScope(
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

function resolveSqliteStoreScope(
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

function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): string {
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const databaseDir = path.dirname(databasePath);
  if (path.basename(databaseDir) !== "agent") {
    return databaseDir;
  }
  return path.join(path.dirname(databaseDir), "sessions");
}

function resolveSqliteTranscriptScope(
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
    ...resolveSqliteScope({
      ...scope,
      sessionKey: scope.sessionKey,
    }),
    sessionId: scope.sessionId,
  };
}

function resolveSqliteTranscriptReadScope(
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

function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}

function normalizeSqliteSessionKey(sessionKey: string): string {
  return normalizeStoreSessionKey(sessionKey);
}

function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

function preserveSqliteSameKeySessionRolloverLineage(params: {
  next: SessionEntry;
  previous: SessionEntry;
  sessionKey: string;
}): SessionEntry {
  const previousSessionId = params.previous.sessionId.trim();
  const nextSessionId = params.next.sessionId.trim();
  if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return params.next;
  }

  return {
    ...params.next,
    usageFamilyKey:
      params.next.usageFamilyKey ?? params.previous.usageFamilyKey ?? params.sessionKey,
    usageFamilySessionIds: uniqueStrings([
      ...(params.previous.usageFamilySessionIds ?? []),
      previousSessionId,
      ...(params.next.usageFamilySessionIds ?? []),
      nextSessionId,
    ]),
  };
}

function normalizeSqliteText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSqliteChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

function normalizeSqliteStatus(
  value: unknown,
): "running" | "done" | "failed" | "killed" | "timeout" | null {
  if (
    value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
  ) {
    return value;
  }
  return null;
}

function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function parseSessionEntryRow(row: Pick<SessionEntryRow, "entry_json">): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SessionEntry)
      : null;
  } catch {
    return null;
  }
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendSqliteTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendSqliteTranscriptEvent cannot write message transcript records; use appendSqliteTranscriptMessage instead.",
    );
  }
}

function readSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  if (lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .selectAll()
      .where("session_key", "in", lookupKeys)
      .orderBy("session_key", "asc"),
  ).rows;
  const entries = new Map<string, ResolvedSessionEntryRow>();
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    store[row.session_key] = entry;
    entries.set(row.session_key, { entry, legacyKeys: [], row });
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  if (!resolved.existing) {
    return undefined;
  }
  for (const value of entries.values()) {
    if (value.entry === resolved.existing) {
      return { ...value, legacyKeys: resolved.legacyKeys };
    }
  }
  return undefined;
}

// Async updaters prepare against this complete selection. Capturing alias rows
// prevents the commit phase from deleting a concurrently changed legacy key.
function readSqliteSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionEntrySelectionSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  const selectedKeys = selected
    ? uniqueStrings([selected.row.session_key, ...selected.legacyKeys]).toSorted()
    : [];
  return {
    selected,
    selectedRows: selectedKeys.flatMap((candidateKey) => {
      const row = readExactSessionEntryRow(database, candidateKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey: candidateKey }] : [];
    }),
  };
}

function assertSqliteSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
): void {
  const selectedMatches =
    expected.selected?.row.session_key === current.selected?.row.session_key &&
    sqliteSessionEntriesEqual(expected.selected?.entry, current.selected?.entry);
  if (
    !selectedMatches ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows)
  ) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

function collectSessionEntryLookupKeys(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): string[] {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) {
    return [];
  }
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const lookupKeys = new Set([
    trimmedKey,
    normalizedKey,
    ...foldedSessionKeyAliasCandidates(normalizedKey),
  ]);
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select("session_key").orderBy("session_key", "asc"),
  ).rows;
  for (const row of rows) {
    if (normalizeStoreSessionKey(row.session_key) === normalizedKey) {
      lookupKeys.add(row.session_key);
    }
  }
  return [...lookupKeys].filter(Boolean);
}

function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKey: string,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let currentKey = normalizeStoreSessionKey(activeSessionKey);
  while (currentKey && !seen.has(currentKey)) {
    seen.add(currentKey);
    keys.push(currentKey);
    currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
  }
  return keys;
}

function sumEventJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(event_json AS BLOB))), 0)`.as("event_json_bytes")
  );
}

function sumSessionEntryJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(entry_json AS BLOB))), 0)`.as("entry_json_bytes")
  );
}

function readSqliteSessionRowBytes(database: OpenClawAgentDatabase): {
  entryBytesByKey: Map<string, number>;
  trajectoryBytesBySessionId: Map<string, number>;
  transcriptBytesBySessionId: Map<string, number>;
} {
  const db = getSessionKysely(database.db);
  const entryRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]),
  ).rows;
  const transcriptRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const trajectoryRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const entryBytesByKey = new Map<string, number>();
  for (const row of entryRows) {
    entryBytesByKey.set(row.session_key, Buffer.byteLength(row.entry_json, "utf8"));
  }
  const transcriptBytesBySessionId = new Map<string, number>();
  for (const row of transcriptRows) {
    const bytes = row.event_json_bytes;
    transcriptBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  const trajectoryBytesBySessionId = new Map<string, number>();
  for (const row of trajectoryRows) {
    const bytes = row.event_json_bytes;
    trajectoryBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  return { entryBytesByKey, trajectoryBytesBySessionId, transcriptBytesBySessionId };
}

function getSqliteSessionStateBytes(
  rowBytes: ReturnType<typeof readSqliteSessionRowBytes>,
  sessionId: string,
): number {
  return (
    (rowBytes.transcriptBytesBySessionId.get(sessionId) ?? 0) +
    (rowBytes.trajectoryBytesBySessionId.get(sessionId) ?? 0)
  );
}

function getSqliteSessionEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

function hasSqliteSessionDiskBudgetOverflow(
  database: OpenClawAgentDatabase,
  maintenance: ResolvedSessionMaintenanceConfig,
): boolean {
  if (maintenance.maxDiskBytes == null || maintenance.highWaterBytes == null) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const entryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select(sumSessionEntryJsonBytes()),
  );
  const transcriptRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("transcript_events").select(sumEventJsonBytes()),
  );
  const trajectoryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("trajectory_runtime_events").select(sumEventJsonBytes()),
  );
  const entryBytes = normalizeSqliteNumber(entryRow?.entry_json_bytes ?? 0);
  const transcriptBytes = normalizeSqliteNumber(transcriptRow?.event_json_bytes ?? 0);
  const trajectoryBytes = normalizeSqliteNumber(trajectoryRow?.event_json_bytes ?? 0);
  return entryBytes + transcriptBytes + trajectoryBytes > maintenance.maxDiskBytes;
}

function applySqliteSessionDiskBudget(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: ResolvedSessionMaintenanceConfig;
  preserveKeys: ReadonlySet<string>;
  rememberRemovedEntry: (removed: { key: string; entry: SessionEntry }) => void;
}): void {
  enforceSqliteSessionDiskBudgetInStore({
    database: params.database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys: params.preserveKeys,
    onRemoveEntry: params.rememberRemovedEntry,
  });
}

function enforceSqliteSessionDiskBudgetInStore(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
  onRemoveEntry?: (removed: { key: string; entry: SessionEntry }) => void;
}): SessionDiskBudgetSweepResult | null {
  const { maxDiskBytes, highWaterBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return null;
  }
  const rowBytes = readSqliteSessionRowBytes(params.database);
  let totalBytes = 0;
  const entryBytesByKey = new Map<string, number>();
  const sessionIdsByKey = new Map<string, readonly string[]>();
  const sessionIdRefCounts = new Map<string, number>();
  // Session state rows can be shared through usage-family references. Count
  // each referenced session id once, then subtract rows only after the last
  // remaining entry reference is removed.
  for (const [key, entry] of Object.entries(params.store)) {
    const entryBytes = rowBytes.entryBytesByKey.get(key) ?? 0;
    const sessionIds = collectSqliteSessionStateIdsForEntry(entry);
    entryBytesByKey.set(key, entryBytes);
    sessionIdsByKey.set(key, sessionIds);
    totalBytes += entryBytes;
    for (const sessionId of sessionIds) {
      sessionIdRefCounts.set(sessionId, (sessionIdRefCounts.get(sessionId) ?? 0) + 1);
    }
  }
  for (const sessionId of sessionIdRefCounts.keys()) {
    totalBytes += getSqliteSessionStateBytes(rowBytes, sessionId);
  }
  const totalBytesBefore = totalBytes;
  if (totalBytes <= maxDiskBytes) {
    return {
      totalBytesBefore,
      totalBytesAfter: totalBytes,
      removedFiles: 0,
      removedEntries: 0,
      freedBytes: 0,
      maxBytes: maxDiskBytes,
      highWaterBytes,
      overBudget: false,
    };
  }
  let removedEntries = 0;
  const keys = Object.keys(params.store).toSorted((a, b) => {
    const aTime = getSqliteSessionEntryUpdatedAt(params.store[a]);
    const bTime = getSqliteSessionEntryUpdatedAt(params.store[b]);
    return aTime - bTime;
  });
  for (const key of keys) {
    if (totalBytes <= highWaterBytes) {
      break;
    }
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    if (shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: params.preserveKeys })) {
      continue;
    }
    params.onRemoveEntry?.({ key, entry });
    delete params.store[key];
    removedEntries += 1;
    totalBytes -= entryBytesByKey.get(key) ?? 0;
    for (const sessionId of sessionIdsByKey.get(key) ?? []) {
      const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 0) - 1;
      if (nextRefCount > 0) {
        sessionIdRefCounts.set(sessionId, nextRefCount);
        continue;
      }
      sessionIdRefCounts.delete(sessionId);
      totalBytes -= getSqliteSessionStateBytes(rowBytes, sessionId);
    }
  }
  return {
    totalBytesBefore,
    totalBytesAfter: totalBytes,
    removedFiles: 0,
    removedEntries,
    freedBytes: Math.max(0, totalBytesBefore - totalBytes),
    maxBytes: maxDiskBytes,
    highWaterBytes,
    overBudget: true,
  };
}

export function previewSqliteSessionDiskBudget(params: {
  agentId?: string;
  activeSessionKey?: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
}): { diskBudget: SessionDiskBudgetSweepResult | null; removedKeys: Set<string> } {
  const removedKeys = new Set<string>();
  if (params.maintenance.maxDiskBytes == null || params.maintenance.highWaterBytes == null) {
    return { diskBudget: null, removedKeys };
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const baseKeys = collectSqliteSessionMaintenanceBaseKeys(
    params.store,
    params.activeSessionKey ?? "",
  );
  const preserveKeys =
    baseKeys.length > 0 || params.preserveKeys
      ? new Set([...(params.preserveKeys ?? []), ...baseKeys])
      : undefined;
  const diskBudget = enforceSqliteSessionDiskBudgetInStore({
    database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys,
    onRemoveEntry: ({ key }) => {
      removedKeys.add(key);
    },
  });
  return { diskBudget, removedKeys };
}

function readExactSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseSessionEntryRow(row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

function readSqliteSessionEntryStore(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

function readSqliteSessionEntryCount(database: OpenClawAgentDatabase): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select((eb) => eb.fn.countAll<number>().as("entry_count")),
  );
  const count = row?.entry_count;
  return count === undefined || count === null ? 0 : normalizeSqliteNumber(count);
}

function hasStaleSqliteSessionEntryCandidate(
  database: OpenClawAgentDatabase,
  pruneAfterMs: number,
  preserveKeys: ReadonlySet<string> | undefined,
): boolean {
  const cutoffMs = Date.now() - pruneAfterMs;
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("session_key")
      .where("updated_at", "<", cutoffMs)
      .orderBy("updated_at", "asc"),
  ).rows;
  return rows.some((row) => !preserveKeys?.has(normalizeStoreSessionKey(row.session_key)));
}

function resolveSqliteLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of target.storeKeys) {
    const row = readExactSessionEntryRow(database, key.trim());
    if (!row) {
      continue;
    }
    if (!freshest || (row.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = { key, entry: row.entry };
    }
  }
  return freshest ?? undefined;
}

function readSqliteLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): SqliteLifecycleTargetSnapshot {
  const normalized = normalizeSqliteLifecycleTarget(target);
  return {
    primary: resolveSqliteLifecyclePrimaryEntry(database, normalized),
    rows: normalized.storeKeys.flatMap((sessionKey) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey }] : [];
    }),
  };
}

function assertSqliteLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  const primaryMatches =
    expected.primary?.key === current.primary?.key &&
    sqliteSessionEntriesEqual(expected.primary?.entry, current.primary?.entry);
  if (!primaryMatches || !sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

function normalizeSqliteLifecycleTarget(target: { canonicalKey: string; storeKeys: string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeSqliteSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeSqliteSessionKey)]),
  };
}

function deleteSqliteSessionEntryRows(database: OpenClawAgentDatabase, sessionKey: string): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_routes").where("session_key", "=", sessionKey),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_entries").where("session_key", "=", sessionKey),
  );
}

function deleteSqliteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSqliteSessionEntryRows(database, trimmed);
    }
  }
}

function shouldRemoveSqliteSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    JSON.stringify(entry) !== JSON.stringify(removal.expectedEntry)
  ) {
    return false;
  }
  if (removal.expectedSessionId !== undefined && entry.sessionId !== removal.expectedSessionId) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function shouldDeleteSqliteSessionEntryLifecycle(
  entry: SessionEntry | undefined,
  params: DeleteSessionEntryLifecycleParams,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    params.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, params.expectedEntry)
  ) {
    return false;
  }
  if (params.expectedSessionId !== undefined && entry.sessionId !== params.expectedSessionId) {
    return false;
  }
  if (
    params.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    return false;
  }
  if (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

function sqliteLifecycleTargetMatchesExpectedEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
): boolean {
  const current = resolveSqliteLifecyclePrimaryEntry(database, target)?.entry;
  if (!current || !expectedEntry) {
    return current === expectedEntry;
  }
  return sqliteSessionEntriesEqual(current, expectedEntry);
}

function assertSqliteLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
  operation: "deleted" | "reset",
): void {
  if (sqliteLifecycleTargetMatchesExpectedEntry(database, target, expectedEntry)) {
    return;
  }
  throw new Error(`SQLite session entry changed before ${operation} lifecycle mutation`);
}

function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", legacyKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", legacyKey),
    );
  }
}

function applySqliteSessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    skipMaintenance?: boolean;
  },
): SqliteSessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const entryCount = readSqliteSessionEntryCount(database);
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = hasStaleSqliteSessionEntryCandidate(
    database,
    maintenance.pruneAfterMs,
    preserveCandidateKeys,
  );
  const hasDiskBudgetOverflow = hasSqliteSessionDiskBudgetOverflow(database, maintenance);
  const shouldLoadStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleCandidate ||
    hasDiskBudgetOverflow ||
    shouldRunModelRunPrune({
      maintenance,
      entryCount,
      force: params.forceMaintenance,
    }) ||
    shouldRunSessionEntryMaintenance({
      entryCount,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    });
  if (!shouldLoadStore) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }

  const removedKeys = new Set<string>();
  const removedEntriesByKey = new Map<string, SessionEntry>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    removedEntriesByKey.set(removed.key, cloneSessionEntry(removed.entry));
    for (const sessionId of collectSqliteSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  const preserveKeys =
    collectSessionMaintenancePreserveKeys(
      collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
    ) ?? new Set<string>();
  if (
    shouldRunModelRunPrune({
      maintenance,
      entryCount: Object.keys(store).length,
      force: params.forceMaintenance,
    })
  ) {
    pruneStaleModelRunEntries(store, maintenance.modelRunPruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    Object.keys(store).length > maintenance.maxEntries
  ) {
    pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: Object.keys(store).length,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  ) {
    capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
    });
  }
  applySqliteSessionDiskBudget({
    database,
    store,
    maintenance,
    preserveKeys,
    rememberRemovedEntry,
  });

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: removedKeys,
    projectedStore: store,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    entryRemovals: [...removedKeys].map((sessionKey) => ({
      expectedEntry: removedEntriesByKey.get(sessionKey),
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
  };
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function readSessionTranscriptUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return normalizeSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const updatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  transcriptContentMarker: string;
}): boolean {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.some((row) => row.event_json.includes(params.transcriptContentMarker));
}

function readReferencedSqliteSessionIds(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
function readReferencedSqliteSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  nextEntry?: SessionEntry,
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (removedKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  if (nextEntry) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

function readSqliteTranscriptArchiveLines(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => row.event_json);
}

function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  reason: "deleted" | "reset";
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(
    archiveDirectory,
    `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

function findMatchingSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: "deleted" | "reset";
  sessionId: string;
}): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    const compressed = entry.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile()) {
        continue;
      }
      // Compressed size never matches the utf8 length, so the cheap size
      // precheck only applies to plain archives.
      if (!compressed && stat.size !== Buffer.byteLength(params.content, "utf8")) {
        continue;
      }
      if (readSessionArchiveContentSync(archivePath) === params.content) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function writeSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: "deleted" | "reset";
  sessionId: string;
}): string {
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const existing = findMatchingSqliteTranscriptArchive(params);
  if (existing) {
    return existing;
  }
  // Archives are the long-lived cold tier; compress when the runtime can so
  // keep-forever retention stays cheap. Plain JSONL is the Bun/older fallback.
  const encoded = encodeSessionArchiveContent(params.content);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const archivePath = `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: params.archiveDirectory,
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: Date.now() + attempt,
    })}${encoded.suffix}`;
    if (fs.existsSync(archivePath)) {
      continue;
    }
    const tempPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, encoded.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      fsyncRegularFile(tempPath);
      fs.renameSync(tempPath, archivePath);
      fsyncDirectory(params.archiveDirectory);
      return archivePath;
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      if ((err as { code?: unknown })?.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
}

function fsyncRegularFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every supported platform/filesystem.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function planSqliteSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SqliteSessionStateDeletePlan | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  const lines = readSqliteTranscriptArchiveLines(params.database, params.sessionId);
  return {
    archiveDirectory: params.archiveDirectory,
    archiveTranscript: params.archiveTranscript !== false,
    content: serializeJsonlLines(lines),
    hadTranscriptState:
      readSessionTranscriptUpdatedAt(params.database, params.sessionId) !== undefined,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
  };
}

// Runs duplicate probing, archive write, rename, and fsync outside SQLite
// write transactions; deletion later consumes this durable proof.
function materializeSqliteSessionStateDeletePlans(
  plans: readonly SqliteSessionStateDeletePlan[],
): MaterializedSqliteSessionStateDeletePlan[] {
  return dedupeSqliteSessionStateDeletePlans(plans).map((plan) => {
    const archivedTranscript =
      plan.archiveTranscript && plan.content.length > 0
        ? {
            archivedPath: writeSqliteTranscriptArchive({
              archiveDirectory: plan.archiveDirectory,
              content: plan.content,
              reason: plan.reason,
              sessionId: plan.sessionId,
            }),
            sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
          }
        : null;
    return Object.assign({}, plan, { archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session; dedupe before
// validation so the first row deletion does not stale a duplicate plan.
// If any owner asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SqliteSessionStateDeletePlan[],
): SqliteSessionStateDeletePlan[] {
  const deduped = new Map<string, SqliteSessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (existing.content !== plan.content || existing.reason !== plan.reason) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}

function finalizeSqliteSessionEntryMaintenancePlansBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SqliteSessionEntryMaintenancePlan[],
): SessionLifecycleArchivedTranscript[] {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    return [];
  }
  try {
    const materializedPlans = materializeSqliteSessionStateDeletePlans(stateDeletePlans);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((database) => {
      deletePlannedSqliteLifecycleArtifactEntries(database, entryRemovals);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(database, materializedPlans);
    }, toDatabaseOptions(scope));
    return archivedTranscripts;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite session maintenance cleanup failed",
      {
        agentId: scope.agentId,
        error,
        path: scope.path,
        sessionIds: uniqueStrings(stateDeletePlans.map((plan) => plan.sessionId)),
      },
    );
    return [];
  }
}

// Revalidates transcript bytes before row deletion so a concurrent append is
// not dropped by an archive prepared from older content.
function deleteMaterializedSqliteSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSqliteSessionStateDeletePlan[],
): SessionLifecycleArchivedTranscript[] {
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  for (const plan of plans) {
    if (referencedSessionIds.has(plan.sessionId)) {
      continue;
    }
    if (plan.archiveTranscript) {
      const currentContent = serializeJsonlLines(
        readSqliteTranscriptArchiveLines(database, plan.sessionId),
      );
      if (currentContent !== plan.content) {
        throw new Error(`SQLite transcript changed before archive deletion for ${plan.sessionId}`);
      }
    }
    deleteSqliteSessionStateRows(database, plan.sessionId);
    if (plan.hadTranscriptState && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
function planSqliteSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SqliteSessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSqliteSessionIds(params.database);
  const plans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of collectSqliteSessionStateIdsForEntry(params.entry)) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
async function projectSqliteSessionEntryLifecycleMutation(
  database: OpenClawAgentDatabase,
  params: {
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<SqliteProjectedLifecycleMutation> {
  const store = readSqliteSessionEntryStore(database);
  const removedEntries: Array<{ archiveTranscript: boolean; entry: SessionEntry }> = [];
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: SqliteProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.sessionKey.trim();
    const entry = sessionKey ? store[sessionKey] : undefined;
    if (!shouldRemoveSqliteSessionEntry(entry, removal)) {
      continue;
    }
    projectedRemovals.push({
      expectedEntry: cloneSessionEntry(entry),
      removal,
      sessionKey,
    });
    removedEntries.push({
      archiveTranscript: removal.archiveRemovedTranscript === true,
      entry,
    });
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  const upsertedEntries: SqliteProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
            sessionKey,
            store,
          });
    if (!entry) {
      continue;
    }
    const cloned = cloneSessionEntry(entry);
    store[sessionKey] = cloned;
    changedSessionKeys.add(sessionKey);
    upsertedEntries.push({ expectedEntry, sessionKey, entry: cloned });
  }
  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
  });
  const deletePlans = removedEntries.flatMap(({ archiveTranscript, entry }) =>
    planSqliteSessionStateAfterEntryRemoval({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  return { deletePlans, removals: projectedRemovals, upsertedEntries };
}

// Builds the post-removal reference set from an in-memory projected store.
function collectReferencedSqliteSessionIdsFromStore(
  store: Record<string, SessionEntry>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const entry of Object.values(store)) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projected deletes must preserve raw session_entries.session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
function collectProjectedReferencedSqliteSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  for (const sessionId of collectReferencedSqliteSessionIdsFromStore(params.projectedStore)) {
    sessionIds.add(sessionId);
  }
  return sessionIds;
}

function collectSqliteSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of entry.compactionCheckpoints ?? []) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

function emitArchivedSqliteTranscriptUpdates(
  archivedTranscripts: readonly SessionLifecycleArchivedTranscript[],
): void {
  for (const archived of archivedTranscripts) {
    emitSessionTranscriptUpdate({ sessionFile: archived.archivedPath });
  }
}

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("sessions").where("session_id", "=", sessionId),
  );
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): SqliteSessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select("session_id").orderBy("session_id", "asc"),
  ).rows;

  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a sessions row without a live
  // session entry. The marker keeps this scoped to the caller-owned lifecycle.
  for (const row of rows) {
    if (
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id)
    ) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database: params.database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) ||
      !sqliteTranscriptStateHasMarker({
        database: params.database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      continue;
    }
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      referencedSessionIds: params.referencedSessionIds,
      sessionId: row.session_id,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return deletePlans;
}

function planSqliteSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): SqliteLifecycleArtifactCleanupPlan {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["entry_json", "session_key", "session_id"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  const entries: SqliteLifecycleArtifactCleanupPlan["entries"] = [];
  const projectedStore = readSqliteSessionEntryStore(database);
  for (const row of rows) {
    if (!sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    const entry = parseSessionEntryRow(row);
    for (const sessionId of entry
      ? collectSqliteSessionStateIdsForEntry(entry)
      : [row.session_id]) {
      removedSessionIds.add(sessionId);
    }
    entries.push({
      expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
      sessionKey: row.session_key,
    });
    delete projectedStore[row.session_key];
  }

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: entries.map((entry) => entry.sessionKey),
    projectedStore,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  deletePlans.push(
    ...planSqliteOrphanLifecycleTranscriptStateDeletes({
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      excludedSessionIds: removedSessionIds,
      referencedSessionIds,
      transcriptContentMarker: params.transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs,
    }),
  );
  return { deletePlans, entries };
}

function deletePlannedSqliteLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SqliteSessionEntryRemovalPlan[],
): number {
  let removedEntries = 0;
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      throw new Error(`SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`);
    }
    deleteSqliteSessionEntryRows(database, planned.sessionKey);
    removedEntries += 1;
  }
  return removedEntries;
}

function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const db = getSessionKysely(database.db);
  const normalizedEntry = normalizeSqliteSessionEntryTimestamp(entry);
  const updatedAt = normalizedEntry.updatedAt;
  const sessionRow = bindSqliteSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          session_scope: sessionRow.session_scope,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  writeSessionRoute(database, {
    sessionId: sessionRow.session_id,
    sessionKey,
    updatedAt,
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values({
        session_key: sessionKey,
        session_id: normalizedEntry.sessionId,
        entry_json: JSON.stringify(normalizedEntry),
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: normalizedEntry.sessionId,
          entry_json: JSON.stringify(normalizedEntry),
          updated_at: updatedAt,
        }),
      ),
  );
}

function normalizeSqliteSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  if (typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)) {
    return entry;
  }
  const updatedAt =
    typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)
      ? entry.sessionStartedAt
      : Date.now();
  return {
    ...entry,
    updatedAt,
  };
}

function ensureTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  updatedAt: number,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values({
        session_id: scope.sessionId,
        session_key: scope.sessionKey,
        session_scope: "conversation",
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: scope.sessionKey,
          updated_at: updatedAt,
        }),
      ),
  );
  writeTranscriptSessionRoute(database, {
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    updatedAt,
  });
}

function bindSqliteSessionRoot(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const updatedAt = Number.isFinite(params.entry.updatedAt)
    ? params.entry.updatedAt
    : params.updatedAt;
  return {
    session_id: params.entry.sessionId,
    session_key: params.sessionKey,
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeSqliteStatus(params.entry.status),
    chat_type: normalizeSqliteChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    primary_conversation_id: null,
    model_provider: normalizeSqliteText(params.entry.modelProvider),
    model: normalizeSqliteText(params.entry.model),
    agent_harness_id: normalizeSqliteText(params.entry.agentHarnessId),
    parent_session_key: normalizeSqliteText(params.entry.parentSessionKey),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

function writeSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_routes")
      .values({
        session_key: params.sessionKey,
        session_id: params.sessionId,
        updated_at: params.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: params.sessionId,
          updated_at: params.updatedAt,
        }),
      ),
  );
}

function writeTranscriptSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_routes")
      .select("session_id")
      .where("session_key", "=", params.sessionKey),
  );
  // Transcript-only appends may arrive late from an old run. They can create
  // missing routes, but must not move a current session key back to a stale id.
  if (existing && existing.session_id !== params.sessionId) {
    return;
  }
  writeSessionRoute(database, params);
}

function resolveSqliteSessionScope(
  entry: Pick<SessionEntry, "chatType">,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSqliteChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSqliteSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function finiteSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveSqliteSessionChannel(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.channel) ??
    normalizeSqliteText(entry.deliveryContext?.channel) ??
    normalizeSqliteText(entry.lastChannel) ??
    normalizeSqliteText(entry.origin?.provider)
  );
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.deliveryContext?.accountId) ??
    normalizeSqliteText(entry.lastAccountId) ??
    normalizeSqliteText(entry.origin?.accountId)
  );
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.displayName) ??
    normalizeSqliteText(entry.label) ??
    normalizeSqliteText(entry.subject) ??
    normalizeSqliteText(entry.groupId)
  );
}

function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  );
  const maxSeq =
    row?.max_seq === null || row?.max_seq === undefined ? -1 : normalizeSqliteNumber(row.max_seq);
  return maxSeq + 1;
}

function deleteSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_event_identities").where("session_id", "=", sessionId),
  );
  const result = executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
  );
  return (result.numAffectedRows ?? 0n) > 0n;
}

const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

function resolveSqliteParentForkDecision(
  parentEntry: SessionEntry,
  transcriptEstimate?: SqliteTranscriptParentTokenEstimate,
): SessionParentForkDecision {
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens =
    resolveFreshSessionTotalTokens(parentEntry) ??
    (transcriptEstimate?.kind === "exact-context"
      ? transcriptEstimate.tokens
      : maxPositiveTokenCount(transcriptEstimate?.tokens, resolveSessionTotalTokens(parentEntry)));
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
}

/** Resolves the parent fork decision using SQLite transcript rows when totals are stale. */
export async function resolveSqliteSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  const needsTranscriptTokenEstimate =
    typeof resolveFreshSessionTotalTokens(params.parentEntry) !== "number" &&
    parentSessionId.length > 0;
  if (!needsTranscriptTokenEstimate) {
    return resolveSqliteParentForkDecision(params.parentEntry);
  }
  const resolved = resolveSqliteStoreScope(params.storePath);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return resolveSqliteParentForkDecision(
    params.parentEntry,
    estimateSqliteTranscriptPromptTokens(
      loadSqliteTranscriptEventsFromDatabase(database, parentSessionId),
    ),
  );
}

function estimateSqliteTranscriptPromptTokens(
  events: readonly TranscriptEvent[],
): SqliteTranscriptParentTokenEstimate | undefined {
  let byteEstimate = 0;
  let latestUsageEstimate: number | undefined;
  let latestUsageEstimateIsExactContext = false;
  let trailingBytes = 0;
  for (const event of selectSqliteParentForkTokenEstimateEvents(events)) {
    const serialized = JSON.stringify(event);
    const serializedBytes = Buffer.byteLength(serialized) + 1;
    byteEstimate += serializedBytes;
    if (!isRecord(event)) {
      if (latestUsageEstimate !== undefined) {
        trailingBytes += serializedBytes;
      }
      continue;
    }
    const message = isRecord(event.message) ? event.message : undefined;
    const usageRaw = isRecord(message?.usage)
      ? message.usage
      : isRecord(event.usage)
        ? event.usage
        : undefined;
    if (!usageRaw) {
      if (latestUsageEstimate !== undefined) {
        trailingBytes += serializedBytes;
      }
      continue;
    }
    const contextUsage = readSqliteTranscriptContextUsage(usageRaw);
    if (contextUsage?.state === "unavailable") {
      latestUsageEstimate = undefined;
      latestUsageEstimateIsExactContext = false;
      trailingBytes = 0;
      continue;
    }
    if (contextUsage?.state === "available") {
      latestUsageEstimate = normalizePositiveTokenCount(contextUsage.totalTokens);
      latestUsageEstimateIsExactContext = true;
      trailingBytes = 0;
      continue;
    }
    const usage = normalizeUsage(usageRaw);
    const promptTokens = normalizePositiveTokenCount(
      derivePromptTokens({
        input: usage?.input,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      }),
    );
    const outputTokens = normalizePositiveTokenCount(usage?.output) ?? 0;
    const totalTokens =
      promptTokens === undefined
        ? undefined
        : normalizePositiveTokenCount(promptTokens + outputTokens);
    if (typeof totalTokens === "number") {
      latestUsageEstimate = totalTokens;
      latestUsageEstimateIsExactContext = false;
      trailingBytes = 0;
    }
  }
  if (latestUsageEstimate !== undefined) {
    const trailingTokens = Math.ceil(trailingBytes / 4);
    const tokens = normalizePositiveTokenCount(latestUsageEstimate + trailingTokens);
    return tokens === undefined
      ? undefined
      : {
          kind: latestUsageEstimateIsExactContext ? "exact-context" : "legacy-or-bytes",
          tokens,
        };
  }
  const estimatedFromBytes = Math.ceil(byteEstimate / 4);
  const tokens = normalizePositiveTokenCount(estimatedFromBytes);
  return tokens === undefined ? undefined : { kind: "legacy-or-bytes", tokens };
}

function selectSqliteParentForkTokenEstimateEvents(
  events: readonly TranscriptEvent[],
): TranscriptEvent[] {
  const entries = events.filter((entry) => !(isRecord(entry) && entry.type === "session"));
  const tree = scanSessionTranscriptTree(entries);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  return mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  }).nodes.flatMap((node) => node.entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePositiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function maxPositiveTokenCount(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    const normalized = normalizePositiveTokenCount(value);
    if (normalized !== undefined && (max === undefined || normalized > max)) {
      max = normalized;
    }
  }
  return max;
}

function readSqliteTranscriptContextUsage(
  usageRaw: Record<string, unknown>,
): { state: "available"; totalTokens: number } | { state: "unavailable" } | undefined {
  const contextUsage = usageRaw.contextUsage;
  if (!isRecord(contextUsage)) {
    return undefined;
  }
  if (contextUsage.state === "unavailable") {
    return { state: "unavailable" };
  }
  if (contextUsage.state !== "available") {
    return undefined;
  }
  const totalTokens = normalizePositiveTokenCount(contextUsage.totalTokens);
  return totalTokens === undefined ? undefined : { state: "available", totalTokens };
}

function generateParentForkEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

function hasAssistantEntry(entries: readonly TranscriptEvent[]): boolean {
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant",
  );
}

function collectParentForkBranchLabels(params: {
  allEntries: readonly TranscriptEvent[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
  for (const entry of params.allEntries) {
    if (
      isRecord(entry) &&
      entry.type === "label" &&
      typeof entry.label === "string" &&
      typeof entry.targetId === "string" &&
      typeof entry.id === "string" &&
      !params.pathEntryIds.has(entry.id) &&
      params.pathEntryIds.has(entry.targetId) &&
      typeof entry.timestamp === "string"
    ) {
      labelsToWrite.push({
        targetId: entry.targetId,
        label: entry.label,
        timestamp: entry.timestamp,
      });
    }
  }
  return labelsToWrite;
}

function readSqliteParentForkSourceTranscript(
  database: OpenClawAgentDatabase,
  parentSessionId: string,
): SqliteParentForkSourceTranscript | null {
  const fileEntries = loadSqliteTranscriptEventsFromDatabase(database, parentSessionId);
  if (fileEntries.length === 0) {
    return null;
  }
  const header = fileEntries.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "session",
  );
  const entries = fileEntries.filter((entry) => !(isRecord(entry) && entry.type === "session"));
  const tree = scanSessionTranscriptTree(entries);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  const mergedPath = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  });
  const branchEntries = mergedPath.nodes.flatMap((node) => {
    if (!isRecord(node.entry)) {
      return [];
    }
    const parentId = node.selectedParentId;
    return [node.entry.parentId === parentId ? node.entry : { ...node.entry, parentId }];
  });
  const pathEntryIds = new Set(
    branchEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastLeafUpdateNode = tree.nodes.findLast((node) => node.leafId !== undefined);
  const lastLeafUpdateEntry = lastLeafUpdateNode?.entry;
  return {
    appendParentId: mergedPath.appendParentId,
    ...(lastLeafUpdateNode?.appendMode ? { appendMode: lastLeafUpdateNode.appendMode } : {}),
    branchEntries,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    labelsToWrite: collectParentForkBranchLabels({ allEntries: entries, pathEntryIds }),
    leafId: tree.leafId,
    preserveLeafControl: isSessionTranscriptLeafControl(lastLeafUpdateEntry),
  };
}

function buildParentForkLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): TranscriptEvent[] {
  let parentId = params.lastEntryId;
  const labelEntries: TranscriptEvent[] = [];
  for (const { targetId, label, timestamp } of params.labelsToWrite) {
    const labelEntry = {
      type: "label",
      id: generateParentForkEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    };
    params.pathEntryIds.add(labelEntry.id);
    labelEntries.push(labelEntry);
    parentId = labelEntry.id;
  }
  return labelEntries;
}

function writeSqliteParentForkTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: SqliteParentForkSourceTranscript;
  },
): void {
  const timestamp = new Date().toISOString();
  const pathEntries = params.source.branchEntries;
  const pathEntryIds = new Set(
    pathEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastPathEntry = pathEntries.at(-1);
  const lastPathEntryId =
    isRecord(lastPathEntry) && typeof lastPathEntry.id === "string" ? lastPathEntry.id : null;
  const labelEntries = buildParentForkLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: lastPathEntryId,
  });
  const leafEntry = params.source.preserveLeafControl
    ? {
        type: "leaf",
        id: generateParentForkEntryId(pathEntryIds),
        parentId: (labelEntries.at(-1) as { id?: string } | undefined)?.id ?? lastPathEntryId,
        timestamp,
        targetId: params.source.leafId,
        appendParentId: params.source.appendParentId,
        ...(params.source.appendMode ? { appendMode: params.source.appendMode } : {}),
      }
    : null;
  appendTranscriptEventInTransaction(database, targetScope, {
    ...createSessionTranscriptHeader({
      cwd: params.source.cwd,
      sessionId: targetScope.sessionId,
    }),
    parentSession: params.parentSessionFile,
  });
  for (const event of [...pathEntries, ...labelEntries, ...(leafEntry ? [leafEntry] : [])]) {
    appendTranscriptEventInTransaction(database, targetScope, event);
  }
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    parentEntry: SessionEntry;
    parentSessionKey: string;
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source = readSqliteParentForkSourceTranscript(database, params.parentEntry.sessionId);
  if (!source) {
    return { status: "failed" };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
  writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
    parentSessionFile,
    source,
  });
  return {
    status: "created",
    transcript: {
      sessionFile,
      sessionId,
    },
  };
}

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
    nextSessionFile: forked.sessionFile,
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
    nextSessionFile: restored.sessionFile,
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
  appendTranscriptEventInTransaction(
    database,
    targetScope,
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selected.rows),
      sessionId,
    }),
  );
  for (const event of selected.rows) {
    if (isSessionTranscriptHeader(event)) {
      continue;
    }
    appendTranscriptEventInTransaction(database, targetScope, event);
  }
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
  nextSessionFile: string;
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
    sessionFile: params.nextSessionFile,
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

function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: { dedupeByMessageIdempotency?: boolean } = {},
): boolean {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt);
  const identity = readTranscriptEventIdentity(event);
  if (identity && readTranscriptIdentityByEventId(database, scope.sessionId, identity.eventId)) {
    return false;
  }
  if (
    identity?.messageIdempotencyKey &&
    options.dedupeByMessageIdempotency &&
    readTranscriptIdentityByMessageIdempotencyKey(
      database,
      scope.sessionId,
      identity.messageIdempotencyKey,
    )
  ) {
    return false;
  }
  const seq = readNextTranscriptSeq(database, scope.sessionId);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq,
      event_json: JSON.stringify(event),
      created_at: createdAt,
    }),
  );
  if (!identity) {
    return true;
  }
  // Caller-checked appends may intentionally keep a duplicate key in the
  // message payload, but the identity index can only point at one row.
  const indexedMessageIdempotencyKey =
    identity.messageIdempotencyKey &&
    !options.dedupeByMessageIdempotency &&
    readTranscriptIdentityByMessageIdempotencyKey(
      database,
      scope.sessionId,
      identity.messageIdempotencyKey,
    )
      ? undefined
      : identity.messageIdempotencyKey;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_event_identities")
      .values({
        session_id: scope.sessionId,
        event_id: identity.eventId,
        seq,
        event_type: identity.eventType,
        parent_id: identity.parentId,
        message_idempotency_key: indexedMessageIdempotencyKey,
        created_at: createdAt,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
  );
  return true;
}

function appendTranscriptEventRowInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  seq: number,
  state: {
    seenEventIds: Set<string>;
    seenMessageIdempotencyKeys: Set<string>;
  },
): boolean {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  const identity = readTranscriptEventIdentity(event);
  if (identity && state.seenEventIds.has(identity.eventId)) {
    return false;
  }
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq,
      event_json: JSON.stringify(event),
      created_at: createdAt,
    }),
  );
  if (!identity) {
    return true;
  }
  state.seenEventIds.add(identity.eventId);
  const indexedMessageIdempotencyKey =
    identity.messageIdempotencyKey &&
    !state.seenMessageIdempotencyKeys.has(identity.messageIdempotencyKey)
      ? identity.messageIdempotencyKey
      : undefined;
  if (indexedMessageIdempotencyKey) {
    state.seenMessageIdempotencyKeys.add(indexedMessageIdempotencyKey);
  }
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_event_identities").values({
      session_id: scope.sessionId,
      event_id: identity.eventId,
      seq,
      event_type: identity.eventType,
      parent_id: identity.parentId,
      message_idempotency_key: indexedMessageIdempotencyKey,
      created_at: createdAt,
    }),
  );
  return true;
}

function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
  now: number,
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", scope.sessionId)
      .limit(1),
  );
  if (existing) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({
      cwd,
      sessionId: scope.sessionId,
    }),
  );
  ensureTranscriptSessionRoot(database, scope, now);
}

function readActiveTranscriptAppendParentId(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | null {
  const db = getSessionKysely(database.db);
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities as ti")
      .innerJoin("transcript_events as te", (join) =>
        join.onRef("te.session_id", "=", "ti.session_id").onRef("te.seq", "=", "ti.seq"),
      )
      .select(["ti.event_type", "te.event_json"])
      .where("ti.session_id", "=", sessionId)
      .orderBy("ti.seq", "desc")
      .limit(1),
  );
  if (!latest) {
    return null;
  }
  try {
    const event = JSON.parse(latest.event_json) as unknown;
    const treeEntry = parseSessionTranscriptTreeEntry(event);
    if (!treeEntry) {
      return resolveVisibleTranscriptAppendParentId(
        loadSqliteTranscriptEventsFromDatabase(database, sessionId),
      );
    }
    if (latest.event_type !== "leaf") {
      return treeEntry.appendParentId;
    }
    const leafReferencesKnown =
      treeEntry.leafId !== undefined &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.leafId) &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.appendParentId);
    if (isSessionTranscriptLeafControl(event) && leafReferencesKnown) {
      return treeEntry.appendParentId;
    }
  } catch {
    return resolveVisibleTranscriptAppendParentId(
      loadSqliteTranscriptEventsFromDatabase(database, sessionId),
    );
  }
  return resolveVisibleTranscriptAppendParentId(
    loadSqliteTranscriptEventsFromDatabase(database, sessionId),
  );
}

function transcriptTreeReferenceExists(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string | null,
): boolean {
  return (
    eventId === null || readTranscriptIdentityByEventId(database, sessionId, eventId) !== undefined
  );
}

function replaceSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
): void {
  deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
  if (events.length === 0) {
    return;
  }
  ensureTranscriptSessionRoot(database, resolved, readEventTimestamp(events[0]) ?? Date.now());
  let seq = 0;
  const seenEventIds = new Set<string>();
  const seenMessageIdempotencyKeys = new Set<string>();
  for (const event of events) {
    const appended = appendTranscriptEventRowInTransaction(database, resolved, event, seq, {
      seenEventIds,
      seenMessageIdempotencyKeys,
    });
    if (appended) {
      seq += 1;
    }
  }
}

function readTranscriptIdentityByEventId(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptIdentityByMessageIdempotencyKey(
  database: OpenClawAgentDatabase,
  sessionId: string,
  idempotencyKey: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptMessageByIdempotencyKey(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByMessageIdempotencyKey(
    database,
    scope.sessionId,
    idempotencyKey,
  );
  if (!identity) {
    return undefined;
  }
  return readTranscriptMessageByIdentity(database, scope, identity);
}

function readTranscriptMessageByScopedIdempotencyKey(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
  lookup: TranscriptMessageAppendOptions<unknown>["idempotencyLookup"],
): { messageId: string; message: unknown } | undefined {
  if (lookup !== "scan-assistant") {
    return readTranscriptMessageByIdempotencyKey(database, scope, idempotencyKey);
  }
  const found = findSqliteTranscriptEventInDatabase(database, scope.sessionId, (event) => {
    const message = readTranscriptEventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === idempotencyKey;
  });
  if (!found) {
    return undefined;
  }
  const message = readTranscriptEventMessage(found.event);
  if (!message) {
    return undefined;
  }
  return {
    messageId: readTranscriptEventId(found.event) ?? idempotencyKey,
    message,
  };
}

function readTranscriptMessageByEventId(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByEventId(database, scope.sessionId, eventId);
  if (!identity) {
    return undefined;
  }
  return readTranscriptMessageByIdentity(database, scope, identity);
}

function readTranscriptMessageByIdentity(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  identity: { eventId: string; seq: number },
): { messageId: string; message: unknown } | undefined {
  const db = getSessionKysely(database.db);
  const eventRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", identity.seq),
  );
  if (!eventRow) {
    return undefined;
  }
  const event = JSON.parse(eventRow.event_json) as { message?: unknown };
  return {
    messageId: identity.eventId,
    message: event.message,
  };
}

function readTranscriptEventIdentity(event: unknown):
  | {
      eventId: string;
      eventType: string | null;
      parentId: string | null;
      messageIdempotencyKey: string | null;
    }
  | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const eventId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  if (!eventId) {
    return undefined;
  }
  return {
    eventId,
    eventType: typeof record.type === "string" ? record.type : null,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    messageIdempotencyKey: readMessageIdempotencyKey(record.message),
  };
}

function readMessageIdempotencyKey(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const value = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEventTimestamp(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const value = (event as { timestamp?: unknown }).timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactTranscriptMessageForStorage<TMessage>(
  message: TMessage,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "config">,
): TMessage {
  if (isTranscriptAgentMessage(message)) {
    return redactTranscriptMessage(message, options.config) as TMessage;
  }
  return redactSecrets(message);
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

function formatSqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}

/** Finds the newest transcript record accepted by the matcher without parsing older rows. */
export function findSqliteTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return findSqliteTranscriptEventInDatabase(database, resolved.sessionId, match);
}

function findSqliteTranscriptEventInDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc"),
  ).rows;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed rows are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

function readTranscriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function readTranscriptEventId(event: TranscriptEvent): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/** Records inbound session metadata without refreshing activity timestamps. */
export async function recordSqliteInboundSessionMeta(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveSessionMetaPatch({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        existing: context.existingEntry,
        groupResolution: params.groupResolution,
      }),
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Updates last-route/delivery metadata without refreshing activity timestamps. */
export async function updateSqliteSessionLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: SessionEntry["route"];
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveLastRoutePatch({
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        route: params.route,
        deliveryContext: params.deliveryContext,
        ctx: params.ctx,
        groupResolution: params.groupResolution,
        existing: context.existingEntry,
        sessionKey: params.sessionKey,
      }),
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Writes the forked child's transcript rows (copied branch or header-only). */
function writeSqliteForkedChildTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: SqliteParentForkSourceTranscript;
  },
): void {
  const { parentSessionFile, source } = params;
  const shouldPersistBranch = source.preserveLeafControl || hasAssistantEntry(source.branchEntries);
  if (shouldPersistBranch) {
    writeSqliteParentForkTranscriptInTransaction(database, targetScope, {
      parentSessionFile,
      source,
    });
  } else {
    appendTranscriptEventInTransaction(database, targetScope, {
      ...createSessionTranscriptHeader({ cwd: source.cwd, sessionId: targetScope.sessionId }),
      parentSession: parentSessionFile,
    });
  }
}
