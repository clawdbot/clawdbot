import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import { writeTranscriptArchive } from "./session-accessor.sqlite-archive.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptEventAppendError,
  TranscriptEventAppendOptions,
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
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
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
import { serializeJsonlLines } from "./transcript-jsonl.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

// Transcript write owner. Queue coordination surrounds synchronous SQLite commit sections.

class SqliteTranscriptMutationConflictError extends Error {
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

/** Fully replaces rows for one transcript synchronously for sync session runtimes. */
export function replaceTranscriptEventsSync(
  scope: SessionTranscriptWriteScope,
  events: TranscriptEvent[],
): boolean {
  // Every sync replacement inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let replaced = false;
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
    replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
    replaced = true;
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return replaced;
}

export async function trimTranscriptForManualCompact(
  scope: SessionTranscriptAccessScope,
  selectRetainedLines: (lines: readonly string[]) => readonly string[] | null,
  options: { nowMs?: number } = {},
): Promise<{ trimmed: false } | { archivedPath: string; kept: number; trimmed: true }> {
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
    const archivedPath = writeTranscriptArchive({
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      content: serializeJsonlLines(lines),
      reason: "bak",
      sessionId: resolved.sessionId,
    });
    // Published archives can be reused by another process before this commit.
    // Retain them on failure so a sibling operation never loses its durable proof.
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
    return { archivedPath, kept: retainedLines.length, trimmed: true };
  });
}

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventInTransaction(
        database,
        resolved,
        resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options),
      );
    }, toDatabaseOptions(resolved));
  });
}

/** Appends one raw non-message transcript event synchronously for sync session runtimes. */
export function appendTranscriptEventSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Result<boolean, TranscriptEventAppendError> {
  assertNonMessageTranscriptEvent(event);
  // Every sync event append inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let result: Result<boolean, TranscriptEventAppendError> = ok(false);
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh) {
      result = err({
        code: "session-entry-missing",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    if (fresh.entry.sessionId !== resolved.sessionId) {
      result = err({
        actualSessionId: fresh.entry.sessionId,
        code: "session-rebound",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    if (
      (fencedScope.expectedLifecycleRevision !== undefined &&
        fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
      (fencedScope.expectedWriterRunId !== undefined &&
        (fresh.entry as InternalSessionEntry).activeWriterRunId !== fencedScope.expectedWriterRunId)
    ) {
      result = err({
        actualSessionId: fresh.entry.sessionId,
        code: "session-rebound",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    result = ok(
      appendTranscriptEventInTransaction(
        database,
        resolved,
        resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options),
      ),
    );
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !result.ok) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return result;
}

function resolveTranscriptEventAppendParent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
): TranscriptEvent {
  if (
    options.appendIntent !== "active-branch" ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !("parentId" in event)
  ) {
    return event;
  }
  const parentId = event.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return event;
  }
  const effectiveParentId = resolveTranscriptMessageAppendParent(database, sessionId, {
    appendIntent: "active-branch",
    parentId,
  });
  return effectiveParentId === parentId ? event : { ...event, parentId: effectiveParentId };
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

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
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
    result = appendTranscriptMessageInTransaction(database, resolved, options);
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && result === undefined) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return result;
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

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendTranscriptEvent cannot write message transcript records; use appendTranscriptMessage instead.",
    );
  }
}
