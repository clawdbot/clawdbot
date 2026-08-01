import { randomUUID } from "node:crypto";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { writeSqliteTranscriptArchive } from "./session-accessor.sqlite-archive.js";
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
  assertSqliteSessionEntrySelectionUnchanged,
  collectSessionEntryLookupKeys,
  deleteLegacySessionEntryRows,
  readSessionEntryRow,
  readSqliteSessionEntrySelectionSnapshot,
  readSqliteSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionIdentityDiff } from "./session-accessor.sqlite-identity.js";
import {
  readSqliteTranscriptEventRows,
  readSqliteTranscriptSnapshot,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readCommittedSqliteTranscriptMessageSequence,
  rememberCommittedSqliteTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  ensureTranscriptHeader,
  readMessageIdempotencyKey,
  readTranscriptIdentityByEventId,
  readTranscriptMessageByEventId,
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
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
import { serializeJsonlLines } from "./transcript-jsonl.js";
import type { SessionEntry } from "./types.js";
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
    existingIdempotencyKeys: Set<string>;
    messagesByIdempotencyKey: Map<string, unknown>;
  }>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

type SqliteTranscriptSnapshotState =
  | { kind: "current"; rows: SqliteTranscriptSnapshotRow[] }
  | { kind: "stale" };

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

/** Rewrites exact transcript rows after atomically validating their generation and bytes. */
export async function rewriteSqliteTranscriptEventRowsExact(
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

export async function trimSqliteTranscriptForManualCompact(
  scope: SessionTranscriptAccessScope,
  selectRetainedLines: (lines: readonly string[]) => readonly string[] | null,
  options: { nowMs?: number } = {},
): Promise<{ trimmed: false } | { archivedPath: string; kept: number; trimmed: true }> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const snapshotRows = readSqliteTranscriptEventRows(database, resolved.sessionId);
    const sessionSnapshot = readSqliteSessionEntrySelectionSnapshot(
      database,
      resolved.sessionKey,
      true,
    );
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
    const archivedPath = writeSqliteTranscriptArchive({
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
      const freshSessionSnapshot = readSqliteSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        true,
      );
      assertSqliteSessionEntrySelectionUnchanged(
        sessionSnapshot,
        freshSessionSnapshot,
        "session.transcript.manual-compact",
      );
      const freshEntry = freshSessionSnapshot.selected?.entry;
      if (!freshEntry || freshEntry.sessionId !== resolved.sessionId) {
        throw new Error(`SQLite session changed before compacting ${resolved.sessionId}`);
      }
      const identityKeys = collectSessionEntryLookupKeys(writeDatabase, resolved.sessionKey);
      previousIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
      replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, retainedEvents);
      const nextEntry = cloneSessionEntry(freshEntry);
      delete nextEntry.contextBudgetStatus;
      delete nextEntry.inputTokens;
      delete nextEntry.outputTokens;
      delete nextEntry.totalTokens;
      delete nextEntry.totalTokensFresh;
      nextEntry.updatedAt = options.nowMs ?? Date.now();
      // The transcript rewrite and token invalidation describe one generation.
      // Keep them in this transaction so either both become visible or neither does.
      writeSessionEntry(writeDatabase, resolved.sessionKey, nextEntry, {
        previousEntry: freshEntry,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return { archivedPath, kept: retainedLines.length, trimmed: true };
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
): boolean {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  let appended = false;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    appended = appendTranscriptEventInTransaction(database, resolved, event);
  }, toDatabaseOptions(resolved));
  return appended;
}

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendSqliteExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    atomicGroup?: boolean;
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedLifecycleRevision?: string;
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
        const appended = appendSqliteTranscriptMessageInTransaction(transactionDb, resolved, {
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
      rememberCommittedSqliteTranscriptMessageSequencesInTransaction(
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
        previousIdentity = readSqliteSessionIdentitySnapshot(transactionDb, identityKeys);
        writeSessionEntry(transactionDb, resolved.sessionKey, next);
        deleteLegacySessionEntryRows(transactionDb, fresh.legacyKeys, resolved.sessionKey);
        currentIdentity = readSqliteSessionIdentitySnapshot(transactionDb, identityKeys);
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
    let transcriptSnapshot: SqliteTranscriptSnapshotState | undefined;
    return await run({
      readEvents: async () => {
        const snapshot = readSqliteTranscriptSnapshot(database, resolved.sessionId);
        transcriptSnapshot = { kind: "current", rows: snapshot.rows };
        return snapshot.events;
      },
      readMessageFacts: async (params) =>
        readTranscriptMirrorFacts(database, resolved.sessionId, params),
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
          return readSqliteTranscriptEventRows(writeDatabase, resolved.sessionId);
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
          result = appendSqliteTranscriptMessageInTransaction(writeDatabase, resolved, options);
          if (snapshotState?.kind === "current") {
            nextSnapshotState = snapshotStillCurrent
              ? {
                  kind: "current",
                  rows: readSqliteTranscriptEventRows(writeDatabase, resolved.sessionId),
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
          result = appendSqliteTranscriptMessageInTransaction(writeDatabase, resolved, options);
          if (result) {
            rememberCommittedSqliteTranscriptMessageSequencesInTransaction(
              writeDatabase,
              resolved.sessionId,
              [result],
            );
            messageSeq = readCommittedSqliteTranscriptMessageSequence(result);
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
export async function withSqliteTranscriptWriteTransaction<T>(
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
  const current = readSqliteTranscriptEventRows(database, sessionId);
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

function appendSqliteTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage> & { messageAlreadyRedacted?: boolean },
): TranscriptMessageAppendResult<TMessage> | undefined {
  // Idempotent replays return the stored row with its persisted parent so callers
  // adopt the durable tree instead of re-deriving one from a stale snapshot.
  const existingAppendResult = (found: { message: unknown; messageId: string }) => ({
    appended: false as const,
    effectiveParentId:
      readTranscriptIdentityByEventId(database, resolved.sessionId, found.messageId)?.parentId ??
      null,
    message: found.message as TMessage,
    messageId: found.messageId,
  });
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      return existingAppendResult(existing);
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
  const finalMessage = options.messageAlreadyRedacted
    ? prepared
    : redactTranscriptMessageForStorage(prepared, options);
  ensureTranscriptHeader(database, resolved, options.cwd, now);
  const parentId = resolveTranscriptMessageAppendParent(database, resolved.sessionId, options);
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
      return existingAppendResult(existing);
    }
  }
  if (!appended) {
    const existing = readTranscriptMessageByEventId(database, resolved, messageId);
    if (existing) {
      return existingAppendResult(existing);
    }
  }
  if (!appended) {
    throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
  }
  return {
    appended: true,
    effectiveParentId: parentId ?? null,
    message: finalMessage,
    messageId,
  };
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
