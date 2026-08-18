import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  assertSessionEntrySelectionUnchanged,
  collectSessionEntryLookupKeys,
  deleteLegacySessionEntryRows,
  readSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  readTranscriptEventRows,
  readTranscriptSnapshot,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  type ResolvedTranscriptScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import type { SessionTranscriptWriteTransactionContext } from "./session-accessor.types.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

// Transcript write owner. Queue coordination surrounds synchronous SQLite commit sections.

export class SqliteTranscriptMutationConflictError extends Error {
  constructor(sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "SqliteTranscriptMutationConflictError";
  }
}

type SqliteExpectedSessionTranscriptTurnResult = {
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

type SqliteTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  appendMessageWithMessageSequence: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<{
    messageSeq?: number;
    result: TranscriptMessageAppendResult<TMessage> | undefined;
  }>;
  readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
    anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
    existingIdempotencyKeys: Set<string>;
    messagesByIdempotencyKey: Map<string, unknown>;
  }>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

type SqliteTranscriptSnapshotState =
  | { kind: "current"; rows: SqliteTranscriptSnapshotRow[] }
  | { kind: "stale" };

export async function replaceTranscriptEvents(
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

/** Rewrites exact transcript rows after atomically validating their generation and bytes. */
export async function rewriteTranscriptEventRowsExact(
  scope: SessionTranscriptAccessScope,
  params: {
    allowInitialGenerationMaterialization?: boolean;
    expectedGeneration: string | null;
    rows: readonly { event: TranscriptEvent; expectedEventJson: string; seq: number }[];
  },
): Promise<{ generation: string } | null> {
  if (params.rows.length === 0) {
    return null;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: { generation: string } | null = null;
    runOpenClawAgentWriteTransaction((database) => {
      const currentGeneration =
        readTranscriptGenerationInTransaction(database, resolved.sessionId) ?? null;
      const initialGenerationMaterialized =
        params.allowInitialGenerationMaterialization === true && params.expectedGeneration === null;
      if (currentGeneration !== params.expectedGeneration && !initialGenerationMaterialized) {
        return;
      }
      rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, params.rows);
      const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
      if (generation) {
        result = { generation };
      }
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/**
 * Shared transaction body for the sync transcript-replace entry points. `afterReplace` runs
 * inside the same write transaction immediately after a successful replace, so a caller that
 * needs the resulting row set (e.g. to track a last-known-good snapshot) reads it atomically
 * instead of racing a foreign commit that could land after this transaction commits but before
 * a separate out-of-transaction read.
 */
function replaceTranscriptEventsSyncCore(
  scope: SessionTranscriptWriteScope,
  events: TranscriptEvent[],
  expectedSnapshot: readonly SqliteTranscriptSnapshotRow[] | undefined,
  afterReplace?: (database: OpenClawAgentDatabase, resolved: { sessionId: string }) => void,
): boolean {
  // Every sync replacement inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  // Session-entry guards below protect identity/lifecycle/writer claim, not transcript
  // row content. A caller that tracks its own last-synced row snapshot (e.g.
  // SessionManagerCore) must pass it here: the vulnerability window is between the
  // caller's OWN last read/append and this rewrite, not between a fresh read taken at
  // the top of this function and the transaction below. A fresh read here would already
  // include a foreign row that committed before this call, so it would trivially pass
  // revalidation while `events` (built from the caller's stale in-memory state) still
  // omits that row. Only fall back to a fresh read for callers with no tracked snapshot.
  const snapshotRows = expectedSnapshot ?? readTranscriptEventRows(database, resolved.sessionId);
  let replaced = false;
  runOpenClawAgentWriteTransaction((writeDatabase) => {
    const fresh = readSessionEntryRow(writeDatabase, resolved.sessionKey);
    if (
      !fresh ||
      fresh.entry.sessionId !== resolved.sessionId ||
      (fencedScope.expectedLifecycleRevision !== undefined &&
        fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
      (fencedScope.expectedWriterRunId !== undefined &&
        (fresh.entry as InternalSessionEntry).activeWriterRunId !== fencedScope.expectedWriterRunId)
    ) {
      return;
    }
    // Revalidate after BEGIN IMMEDIATE so a committed cross-process append cannot
    // be silently deleted by this rewrite.
    assertSqliteTranscriptSnapshotUnchanged(writeDatabase, resolved.sessionId, snapshotRows);
    replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
    replaced = true;
    if (replaced) {
      afterReplace?.(writeDatabase, resolved);
    }
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return replaced;
}

/** Fully replaces rows for one transcript synchronously for sync session runtimes. */
export function replaceTranscriptEventsSync(
  scope: SessionTranscriptWriteScope,
  events: TranscriptEvent[],
  expectedSnapshot?: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  return replaceTranscriptEventsSyncCore(scope, events, expectedSnapshot);
}

/**
 * Fully replaces rows for one transcript synchronously and atomically captures the
 * post-replace row snapshot in the same write transaction. Callers that track their own
 * last-known-good snapshot (e.g. SessionManagerCore) must use this instead of
 * replaceTranscriptEventsSync plus a separate out-of-transaction snapshot read: a foreign
 * process committing between this transaction's commit and that later read would otherwise
 * be silently folded into the tracked snapshot without ever appearing in the caller's
 * in-memory entries.
 */
export function replaceTranscriptEventsWithSnapshotSync(
  scope: SessionTranscriptWriteScope,
  events: TranscriptEvent[],
  expectedSnapshot?: readonly SqliteTranscriptSnapshotRow[],
): {
  replaced: boolean;
  snapshot?: SqliteTranscriptSnapshotRow[];
} {
  let snapshot: SqliteTranscriptSnapshotRow[] | undefined;
  const replaced = replaceTranscriptEventsSyncCore(
    scope,
    events,
    expectedSnapshot,
    (database, resolved) => {
      snapshot = readTranscriptEventRows(database, resolved.sessionId);
    },
  );
  return { replaced, ...(snapshot ? { snapshot } : {}) };
}

export async function trimTranscriptForManualCompact(
  scope: SessionTranscriptAccessScope,
  selectRetainedLines: (lines: readonly string[]) => readonly string[] | null,
  options: { nowMs?: number } = {},
): Promise<{ trimmed: false } | { kept: number; trimmed: true }> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const snapshotRows = readTranscriptEventRows(database, resolved.sessionId);
    const sessionSnapshot = readSessionEntrySelectionSnapshot(database, resolved.sessionKey, true);
    const lines = snapshotRows.map((row) => row.eventJson);
    const retainedLines = selectRetainedLines(lines);
    if (!retainedLines) {
      return { trimmed: false };
    }
    if (sessionSnapshot.selected?.entry.sessionId !== resolved.sessionId) {
      throw new Error(
        `Cannot compact SQLite transcript ${resolved.sessionId} without its current session entry`,
      );
    }
    const retainedEvents = retainedLines.map((line) => JSON.parse(line) as TranscriptEvent);
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      assertSqliteTranscriptSnapshotUnchanged(writeDatabase, resolved.sessionId, snapshotRows);
      const freshSessionSnapshot = readSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        true,
      );
      assertSessionEntrySelectionUnchanged(
        sessionSnapshot,
        freshSessionSnapshot,
        "session.transcript.manual-compact",
      );
      const freshEntry = freshSessionSnapshot.selected?.entry;
      if (!freshEntry || freshEntry.sessionId !== resolved.sessionId) {
        throw new Error(`SQLite session changed before compacting ${resolved.sessionId}`);
      }
      const identityKeys = collectSessionEntryLookupKeys(writeDatabase, resolved.sessionKey);
      previousIdentity = readSessionIdentitySnapshot(writeDatabase, identityKeys);
      replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, retainedEvents);
      const nextEntry = cloneSessionEntry(freshEntry);
      delete nextEntry.contextBudgetStatus;
      delete nextEntry.inputTokens;
      delete nextEntry.outputTokens;
      delete nextEntry.totalTokens;
      delete nextEntry.totalTokensFresh;
      delete nextEntry.totalTokensVersion;
      clearAllCliSessions(nextEntry);
      nextEntry.updatedAt = options.nowMs ?? Date.now();
      // The transcript rewrite, binding clear, and token invalidation describe one generation.
      // Keep them in this transaction so either both become visible or neither does.
      writeSessionEntry(writeDatabase, resolved.sessionKey, nextEntry, {
        previousEntry: freshEntry,
      });
      currentIdentity = readSessionIdentitySnapshot(writeDatabase, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return { kept: retainedLines.length, trimmed: true };
  });
}

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    atomicGroup?: boolean;
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedLifecycleRevision?: string;
    expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
    messages: readonly SessionTranscriptTurnMessageAppend[];
    sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
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
    if (!sessionMatchesExpectedTranscriptTurn(preparedEntry, options)) {
      return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
    }
    const messages = await selectAppendableSqliteTranscriptTurnMessages(
      {
        agentId: resolved.agentId,
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
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const fresh = readSessionEntryRow(transactionDb, resolved.sessionKey);
      if (!sessionMatchesExpectedTranscriptTurn(fresh, options)) {
        result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
        return;
      }
      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, ...appendOptions } = append;
        const appended = appendTranscriptMessageInTransaction(transactionDb, resolved, {
          ...appendOptions,
          messageAlreadyRedacted: options.atomicGroup === true,
          ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
          ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        });
        if (appended) {
          appendedMessages.push(appended);
        }
      }
      if (
        options.atomicGroup &&
        (appendedMessages.length !== messages.length ||
          appendedMessages.some((message) => message.appended) !==
            appendedMessages.every((message) => message.appended))
      ) {
        throw new Error("SQLite transcript batch was not wholly inserted or replayed");
      }

      // Later explicit parents can abandon earlier rows. Capture every cursor
      // from the final active projection before this atomic transaction commits.
      rememberCommittedTranscriptMessageSequencesInTransaction(
        transactionDb,
        resolved.sessionId,
        appendedMessages,
      );

      const sessionPatch = buildExpectedTranscriptTurnSessionPatch({
        appendedMessages,
        currentEntry: fresh.entry,
        expectedSessionState: options.expectedSessionState,
        sessionFile: options.sessionFile,
        sessionLifecyclePatch: options.sessionLifecyclePatch,
        touchSessionEntry: options.touchSessionEntry,
      });
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(fresh.entry, sessionPatch)
          : fresh.entry;
      if (next !== fresh.entry) {
        const identityKeys = collectSessionEntryLookupKeys(transactionDb, resolved.sessionKey);
        previousIdentity = readSessionIdentitySnapshot(transactionDb, identityKeys);
        writeSessionEntry(transactionDb, resolved.sessionKey, next);
        deleteLegacySessionEntryRows(transactionDb, fresh.legacyKeys, resolved.sessionKey);
        currentIdentity = readSessionIdentitySnapshot(transactionDb, identityKeys);
      }
      result = {
        appendedMessages,
        sessionEntry: cloneSessionEntry(next),
        sessionFile: options.sessionFile,
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result;
  });
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
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptMessageAppendResult<TMessage> | undefined;
    runOpenClawAgentWriteTransaction((database) => {
      result = appendTranscriptMessageInTransaction(database, resolved, options);
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/**
 * Shared transaction body for the sync message-append entry points. `afterAppend` mirrors
 * appendTranscriptEventSyncCore's contract: it runs inside the same write transaction right
 * after a successful append, so a caller tracking a row snapshot reads it atomically.
 */
function appendTranscriptMessageSyncCore<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
  afterAppend?: (database: OpenClawAgentDatabase, resolved: { sessionId: string }) => void,
  pendingHeader?: PendingTranscriptHeader,
): TranscriptMessageAppendResult<TMessage> | undefined {
  // Every sync message append inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let result: TranscriptMessageAppendResult<TMessage> | undefined;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (
      !fresh ||
      fresh.entry.sessionId !== resolved.sessionId ||
      (fencedScope.expectedLifecycleRevision !== undefined &&
        fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
      (fencedScope.expectedWriterRunId !== undefined &&
        (fresh.entry as InternalSessionEntry).activeWriterRunId !== fencedScope.expectedWriterRunId)
    ) {
      return;
    }
    if (pendingHeader) {
      foldPendingTranscriptHeaderInTransaction(database, resolved, pendingHeader);
    }
    result = appendTranscriptMessageInTransaction(database, resolved, options);
    if (result) {
      afterAppend?.(database, resolved);
    }
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && result === undefined) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return result;
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  return appendTranscriptMessageSyncCore(scope, options);
}

/**
 * Appends one transcript message and atomically captures the post-append row snapshot in
 * the same write transaction. See appendTranscriptEventWithSnapshotSync for why a separate
 * post-commit snapshot read cannot substitute for this.
 */
export function appendTranscriptMessageWithSnapshotSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
  pendingHeader?: PendingTranscriptHeader,
): {
  result: TranscriptMessageAppendResult<TMessage> | undefined;
  snapshot?: SqliteTranscriptSnapshotRow[];
} {
  let snapshot: SqliteTranscriptSnapshotRow[] | undefined;
  const result = appendTranscriptMessageSyncCore(
    scope,
    options,
    (database, resolved) => {
      snapshot = readTranscriptEventRows(database, resolved.sessionId);
    },
    pendingHeader,
  );
  return { result, ...(snapshot ? { snapshot } : {}) };
}

/** Runs read/append transcript work under one SQLite writer-queue critical section. */
export async function withTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SqliteTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    let transcriptSnapshot: SqliteTranscriptSnapshotState | undefined;
    return await run({
      readEvents: async () => {
        const snapshot = readTranscriptSnapshot(database, resolved.sessionId);
        transcriptSnapshot = { kind: "current", rows: snapshot.rows };
        return snapshot.events;
      },
      readMessageFacts: async (params) => readTranscriptMirrorFacts(database, resolved, params),
      replaceEvents: async (events) => {
        if (transcriptSnapshot?.kind === "stale") {
          throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
        }
        const expectedSnapshot = transcriptSnapshot?.rows;
        const nextSnapshot = runOpenClawAgentWriteTransaction((writeDatabase) => {
          if (expectedSnapshot !== undefined) {
            // The writer queue is process-local. Revalidate after BEGIN IMMEDIATE
            // so a committed cross-process append cannot be deleted by the rewrite.
            assertSqliteTranscriptSnapshotUnchanged(
              writeDatabase,
              resolved.sessionId,
              expectedSnapshot,
            );
          }
          replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
          return readTranscriptEventRows(writeDatabase, resolved.sessionId);
        }, toDatabaseOptions(resolved));
        transcriptSnapshot = { kind: "current", rows: nextSnapshot };
      },
      appendMessage: async (options) => {
        let result: TranscriptMessageAppendResult<unknown> | undefined;
        const snapshotState = transcriptSnapshot;
        let nextSnapshotState = snapshotState;
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          const snapshotStillCurrent =
            snapshotState?.kind === "current"
              ? isSqliteTranscriptSnapshotUnchanged(
                  writeDatabase,
                  resolved.sessionId,
                  snapshotState.rows,
                )
              : false;
          result = appendTranscriptMessageInTransaction(writeDatabase, resolved, options);
          if (snapshotState?.kind === "current") {
            nextSnapshotState = snapshotStillCurrent
              ? {
                  kind: "current",
                  rows: readTranscriptEventRows(writeDatabase, resolved.sessionId),
                }
              : { kind: "stale" };
          }
        }, toDatabaseOptions(resolved));
        transcriptSnapshot = nextSnapshotState;
        return result as TranscriptMessageAppendResult<typeof options.message> | undefined;
      },
      appendMessageWithMessageSequence: async (options) => {
        let result: TranscriptMessageAppendResult<unknown> | undefined;
        let messageSeq: number | undefined;
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          result = appendTranscriptMessageInTransaction(writeDatabase, resolved, options);
          if (result) {
            rememberCommittedTranscriptMessageSequencesInTransaction(
              writeDatabase,
              resolved.sessionId,
              [result],
            );
            messageSeq = readCommittedTranscriptMessageSequence(result);
          }
        }, toDatabaseOptions(resolved));
        return {
          ...(messageSeq !== undefined ? { messageSeq } : {}),
          result: result as TranscriptMessageAppendResult<typeof options.message> | undefined,
        };
      },
    });
  });
}

/** Runs synchronous transcript work under one writer queue and SQLite transaction. */
export async function withTranscriptWriteTransaction<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteTransactionContext) => T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () =>
    runOpenClawAgentWriteTransaction(
      () =>
        run({
          agentId: resolved.agentId,
          sessionId: resolved.sessionId,
          sessionKey: resolved.sessionKey,
          storePath:
            resolved.path ??
            scope.storePath ??
            resolveOpenClawAgentSqlitePath({ agentId: resolved.agentId, env: resolved.env }),
        }),
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.batch" },
    ),
  );
}

function isSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  const current = readTranscriptEventRows(database, sessionId);
  return (
    current.length === expected.length &&
    current.every(
      (row, index) =>
        row.seq === expected[index]?.seq && row.eventJson === expected[index]?.eventJson,
    )
  );
}

function assertSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): void {
  if (!isSqliteTranscriptSnapshotUnchanged(database, sessionId, expected)) {
    throw new SqliteTranscriptMutationConflictError(sessionId);
  }
}

/**
 * Guards a manager-tracked append inside its own write transaction. `expectedSnapshot` is the
 * row snapshot the manager last observed; revalidating it before the append's post-write
 * snapshot is captured stops a foreign row that landed before this append from being silently
 * folded into the snapshot the manager then trusts (it never appeared in the manager's
 * `fileEntries`, so a later rewrite would validate that contaminated snapshot and delete the
 * foreign row). `event` is an optional session header the manager deferred until its first
 * record, folded into this same transaction so header and first record commit atomically.
 */
export type PendingTranscriptHeader = {
  event?: TranscriptEvent;
  expectedSnapshot: readonly SqliteTranscriptSnapshotRow[];
};

/**
 * Revalidates a manager-tracked append guard inside an in-progress write transaction, then
 * folds a still-deferred session header if one is present. Runs inside the caller's BEGIN
 * IMMEDIATE so a foreign row committed before this transaction cannot be silently absorbed
 * into the post-write snapshot -- which a later rewrite would then delete -- and so the header
 * (when present) commits atomically with the first record instead of racing it in a separate
 * prior transaction.
 */
export function foldPendingTranscriptHeaderInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  pendingHeader: PendingTranscriptHeader,
): void {
  assertSqliteTranscriptSnapshotUnchanged(
    database,
    resolved.sessionId,
    pendingHeader.expectedSnapshot,
  );
  if (pendingHeader.event) {
    appendTranscriptEventInTransaction(database, resolved, pendingHeader.event);
  }
}
