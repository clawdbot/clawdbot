import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { getCodeModeSourceAppend } from "../../agents/transcript-code-mode-source.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  TranscriptEvent,
  TranscriptMessageAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import {
  createTranscriptIdentityReader,
  findTranscriptEventInDatabase,
  loadTranscriptEventsFromDatabase,
  readTranscriptEventId,
  readTranscriptEventMessage,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  deleteTranscriptEventsInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  createTranscriptIndexAppenderInTransaction,
  deleteSessionTranscriptIndexInTransaction,
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
  shouldRebuildSessionTranscriptIndexSynchronously,
} from "./session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import { resolveVisibleTranscriptAppendParentId } from "./transcript-visible-events.js";

type TranscriptAppendOptions = {
  allowStoredAlias?: boolean;
  idempotencyKeyMode?: "dedupe" | "preserve-owner" | "relocate-owner";
  onProjectionReconcileNeeded?: () => void;
  scheduleProjectionReconcile?: boolean;
  touchMutation?: boolean;
};

type TranscriptAppendCursor = {
  initialized?: boolean;
  readIdentity?: ReturnType<typeof createTranscriptIdentityReader>;
  nextSeq?: number;
  appendToIndex?: ReturnType<typeof createTranscriptIndexAppenderInTransaction>;
  updateWindow?: (createdAt: number) => unknown;
  insertEvent?: ReturnType<typeof createTranscriptEventInserter>;
  insertIdentity?: ReturnType<typeof createTranscriptIdentityInserter>;
};

function createTranscriptEventInserter(database: OpenClawAgentDatabase, sessionId: string) {
  return prepareSqliteQuerySync<{ seq: number; eventJson: string; createdAt: number }>(
    database.db,
    (parameter) =>
      getSessionKysely(database.db)
        .insertInto("transcript_events")
        .values({
          session_id: sessionId,
          seq: parameter((row) => row.seq),
          event_json: parameter((row) => row.eventJson),
          created_at: parameter((row) => row.createdAt),
        }),
  );
}

function createTranscriptIdentityInserter(
  database: OpenClawAgentDatabase,
  sessionId: string,
  ignoreConflicts: boolean,
) {
  return prepareSqliteQuerySync<
    NonNullable<ReturnType<typeof readTranscriptEventIdentity>> & { seq: number; createdAt: number }
  >(database.db, (parameter) =>
    getSessionKysely(database.db)
      .insertInto("transcript_event_identities")
      .values({
        session_id: sessionId,
        event_id: parameter((row) => row.eventId),
        seq: parameter((row) => row.seq),
        event_type: parameter((row) => row.eventType),
        parent_id: parameter((row) => row.parentId),
        // An unowned key is SQL NULL, also the schema default when previously omitted.
        message_idempotency_key: parameter((row) => row.messageIdempotencyKey),
        created_at: parameter((row) => row.createdAt),
      })
      .$if(ignoreConflicts, (query) =>
        query.onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
      ),
  );
}

export function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: TranscriptAppendOptions = {},
): boolean {
  return appendTranscriptEvent(database, scope, event, options);
}

function appendTranscriptEvent(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: TranscriptAppendOptions,
  cursor: TranscriptAppendCursor = {},
): boolean {
  const persistedEvent = canonicalizeTranscriptEventMedia(event);
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(persistedEvent) ?? Date.now();
  if (cursor.initialized) {
    // The first attempt established this window and the batch cannot delete it.
    // Even rejected identities update recency; keep each attempt's write in order.
    cursor.updateWindow ??= prepareSqliteQuerySync<number>(database.db, (parameter) =>
      db
        .updateTable("session_windows")
        .set({ updated_at: parameter((timestamp) => timestamp) })
        .where("session_id", "=", scope.sessionId),
    );
    cursor.updateWindow(createdAt);
  } else {
    ensureTranscriptSessionRoot(database, scope, createdAt, {
      allowStoredAlias: options.allowStoredAlias === true,
    });
    ensureTranscriptGenerationInTransaction(database, scope.sessionId);
    cursor.initialized = true;
  }
  const identity = readTranscriptEventIdentity(persistedEvent);
  if (identity) {
    // Reuse compilation within this batch, but read fresh rows after every append.
    cursor.readIdentity ??= createTranscriptIdentityReader(database, scope.sessionId);
    if (cursor.readIdentity(identity.eventId)) {
      return false;
    }
  }
  const idempotencyKeyOwner = identity?.messageIdempotencyKey
    ? readIdempotencyKeyOwner(database, scope.sessionId, identity.messageIdempotencyKey)
    : undefined;
  if (idempotencyKeyOwner && options.idempotencyKeyMode === "dedupe") {
    return false;
  }
  const seq = cursor.nextSeq ?? readNextTranscriptSeq(database, scope.sessionId);
  cursor.insertEvent ??= createTranscriptEventInserter(database, scope.sessionId);
  cursor.insertEvent({ seq, eventJson: JSON.stringify(persistedEvent), createdAt });
  cursor.nextSeq = seq + 1;
  if (options.touchMutation !== false) {
    touchTranscriptMutationInTransaction(database, scope.sessionId);
  }
  cursor.appendToIndex ??= createTranscriptIndexAppenderInTransaction(database.db, scope.sessionId);
  const projectionNeedsRebuild = cursor.appendToIndex({
    seq,
    event: persistedEvent,
    eventId: identity?.eventId ?? null,
    createdAt,
  });
  if (projectionNeedsRebuild) {
    options.onProjectionReconcileNeeded?.();
  }
  if (identity) {
    // Replayed copies take ownership so later retries resolve on the active branch.
    // scan-assistant preserves a colliding user's ownership instead.
    if (idempotencyKeyOwner && options.idempotencyKeyMode === "relocate-owner") {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("transcript_event_identities")
          .set({ message_idempotency_key: null })
          .where("session_id", "=", scope.sessionId)
          .where("event_id", "=", idempotencyKeyOwner.eventId),
      );
    }
    identity.messageIdempotencyKey =
      idempotencyKeyOwner && options.idempotencyKeyMode !== "relocate-owner"
        ? null
        : identity.messageIdempotencyKey;
    cursor.insertIdentity ??= createTranscriptIdentityInserter(database, scope.sessionId, true);
    cursor.insertIdentity({ ...identity, seq, createdAt });
  }
  scheduleTranscriptProjectionReconcile(database, scope.sessionId, projectionNeedsRebuild, options);
  return true;
}

function scheduleTranscriptProjectionReconcile(
  database: OpenClawAgentDatabase,
  sessionId: string,
  projectionNeedsRebuild: boolean,
  options: { scheduleProjectionReconcile?: boolean },
): void {
  if (!projectionNeedsRebuild || options.scheduleProjectionReconcile === false) {
    return;
  }
  // Dirty state is durable: a missed post-commit kick is recovered by startup/search reconciliation.
  deferOpenClawAgentPostCommitPublication(database, () =>
    startSessionTranscriptIndexReconcile({
      agentId: database.agentId,
      path: database.path,
      preferredSessionId: sessionId,
    }),
  );
}

export function appendTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  events: Iterable<TranscriptEvent, unknown, boolean>,
  options: Omit<TranscriptAppendOptions, "onProjectionReconcileNeeded"> = {},
): number {
  let appended = 0;
  let projectionNeedsRebuild = false;
  // Prepared arrays and the import spool cannot mutate the destination between
  // rows. Sequence and projection facts belong only to this synchronous batch.
  const cursor: TranscriptAppendCursor = {};
  const iterator = events[Symbol.iterator]();
  const appendOptions = {
    ...options,
    onProjectionReconcileNeeded: () => {
      projectionNeedsRebuild = true;
    },
    scheduleProjectionReconcile: false,
    touchMutation: false,
  };
  try {
    let next = iterator.next();
    while (!next.done) {
      const inserted = appendTranscriptEvent(database, scope, next.value, appendOptions, cursor);
      if (inserted) {
        appended += 1;
      }
      // Streaming imports acknowledge only inserted rows in their byte-dedupe
      // spool; ordinary array iterators ignore this feedback.
      next = iterator.next(inserted);
    }
  } catch (error) {
    try {
      iterator.return?.();
    } catch {
      // Preserve the append error if iterator cleanup also fails.
    }
    throw error;
  }
  if (appended > 0) {
    if (options.touchMutation !== false) {
      touchTranscriptMutationInTransaction(database, scope.sessionId);
    }
    scheduleTranscriptProjectionReconcile(
      database,
      scope.sessionId,
      projectionNeedsRebuild,
      options,
    );
  }
  return appended;
}

function appendTranscriptEventRowInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  seq: number,
  state: {
    seenEventIds: Set<string>;
    seenMessageIdempotencyKeys: Set<string>;
    insertEvent: ReturnType<typeof createTranscriptEventInserter>;
    insertIdentity: ReturnType<typeof createTranscriptIdentityInserter>;
  },
  createdAtOverride?: number,
): boolean {
  const persistedEvent = canonicalizeTranscriptEventMedia(event);
  const createdAt = createdAtOverride ?? readEventTimestamp(persistedEvent) ?? Date.now();
  const identity = readTranscriptEventIdentity(persistedEvent);
  if (identity && state.seenEventIds.has(identity.eventId)) {
    return false;
  }
  state.insertEvent({ seq, eventJson: JSON.stringify(persistedEvent), createdAt });
  const appendToIndex = createTranscriptIndexAppenderInTransaction(database.db, scope.sessionId);
  appendToIndex({
    seq,
    event: persistedEvent,
    eventId: identity?.eventId ?? null,
    createdAt,
  });
  if (!identity) {
    return true;
  }
  state.seenEventIds.add(identity.eventId);
  if (identity.messageIdempotencyKey) {
    if (state.seenMessageIdempotencyKeys.has(identity.messageIdempotencyKey)) {
      identity.messageIdempotencyKey = null;
    } else {
      state.seenMessageIdempotencyKeys.add(identity.messageIdempotencyKey);
    }
  }
  state.insertIdentity({ ...identity, seq, createdAt });
  return true;
}

export function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
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
    createSessionTranscriptHeader({ cwd, sessionId: scope.sessionId }),
  );
}

export function readActiveTranscriptAppendParentId(
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
        loadTranscriptEventsFromDatabase(database, sessionId),
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
    // Fall through to the tolerant full-tree resolver.
  }
  return resolveVisibleTranscriptAppendParentId(
    loadTranscriptEventsFromDatabase(database, sessionId),
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

export function replaceSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
  options: {
    createdAtByIndex?: readonly number[];
    /** Keep maintenance rewrites at their existing recency while invalidating stale projections. */
    preserveSessionWindowRecency?: boolean;
  } = {},
): void {
  const rebuildSynchronously =
    events.length > 0 &&
    shouldRebuildSessionTranscriptIndexSynchronously(database.db, resolved.sessionId, events);
  const preservedTranscriptUpdatedAt =
    options.preserveSessionWindowRecency === true
      ? readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt
      : undefined;
  const previousGeneration = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  const deleted = deleteTranscriptEventsInTransaction(database, resolved.sessionId);
  if (events.length === 0) {
    deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
    if (deleted || previousGeneration) {
      rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      recordTranscriptReplacementMutation(
        database,
        resolved.sessionId,
        preservedTranscriptUpdatedAt,
      );
    }
    return;
  }
  if (!deleted || options.preserveSessionWindowRecency !== true) {
    ensureTranscriptSessionRoot(database, resolved, readEventTimestamp(events[0]) ?? Date.now());
  }
  if (deleted || previousGeneration) {
    rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
  } else {
    ensureTranscriptGenerationInTransaction(database, resolved.sessionId);
  }
  if (rebuildSynchronously) {
    deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
  } else {
    // Preserve large old FTS rows; the dirty watermark hides them until worker reconciliation.
    markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
  }
  let seq = 0;
  const state = {
    seenEventIds: new Set<string>(),
    seenMessageIdempotencyKeys: new Set<string>(),
    insertEvent: createTranscriptEventInserter(database, resolved.sessionId),
    insertIdentity: createTranscriptIdentityInserter(database, resolved.sessionId, false),
  };
  for (const [eventIndex, event] of events.entries()) {
    if (
      appendTranscriptEventRowInTransaction(
        database,
        resolved,
        event,
        seq,
        state,
        options.createdAtByIndex?.[eventIndex],
      )
    ) {
      seq += 1;
    }
  }
  if (deleted || seq > 0) {
    recordTranscriptReplacementMutation(database, resolved.sessionId, preservedTranscriptUpdatedAt);
    if (rebuildSynchronously) {
      reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
    } else {
      scheduleTranscriptProjectionReconcile(database, resolved.sessionId, true, {});
    }
  }
}

function recordTranscriptReplacementMutation(
  database: OpenClawAgentDatabase,
  sessionId: string,
  preservedUpdatedAt: number | null | undefined,
): void {
  if (preservedUpdatedAt === undefined || preservedUpdatedAt === null) {
    touchTranscriptMutationInTransaction(database, sessionId);
    return;
  }
  // Maintenance rewrites must invalidate in-flight projections without making an old session
  // look newly active. A one-tick advance preserves ordering while changing the snapshot key.
  advanceTranscriptMutationAtInTransaction(database, sessionId, preservedUpdatedAt, {
    strictly: true,
  });
}

/** Rewrite existing transcript rows exactly, without append-time deduplication. */
export function rewriteSqliteTranscriptEventRowsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  rows: readonly {
    event: TranscriptEvent;
    expectedEventJson: string;
    seq: number;
  }[],
): void {
  if (rows.length === 0) {
    return;
  }
  const rebuildSynchronously = shouldRebuildSessionTranscriptIndexSynchronously(
    database.db,
    resolved.sessionId,
  );
  const db = getSessionKysely(database.db);
  for (const row of rows) {
    const persistedEvent = canonicalizeTranscriptEventMedia(row.event);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_events")
        .set({ event_json: JSON.stringify(persistedEvent) })
        .where("session_id", "=", resolved.sessionId)
        .where("seq", "=", row.seq)
        .where("event_json", "=", row.expectedEventJson),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Transcript row ${resolved.sessionId}:${row.seq} changed before exact rewrite`,
      );
    }
  }
  rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
  touchTranscriptMutationInTransaction(database, resolved.sessionId);
  if (rebuildSynchronously) {
    deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
    reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
  } else {
    markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
    scheduleTranscriptProjectionReconcile(database, resolved.sessionId, true, {});
  }
}

// Text-only transcript repair: rewrites event_json for specific rows in place.
// Preserves seq, created_at, session_key, and session activity recency; rotates the transcript
// generation and rebuilds bounded projections immediately or defers large projections.
export function updateSqliteTranscriptEventJsonInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  updates: ReadonlyArray<{ seq: number; eventJson: string }>,
): void {
  if (updates.length === 0) {
    return;
  }
  const rebuildSynchronously = shouldRebuildSessionTranscriptIndexSynchronously(
    database.db,
    sessionId,
  );
  const db = getSessionKysely(database.db);
  for (const { seq, eventJson } of updates) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_events")
        .set({ event_json: eventJson })
        .where("session_id", "=", sessionId)
        .where("seq", "=", seq),
    );
  }
  rotateTranscriptGenerationInTransaction(database, sessionId);
  if (rebuildSynchronously) {
    deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
    reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  } else {
    markSessionTranscriptIndexDirtyInTransaction(database.db, sessionId);
  }
  // Minimally advance transcript_updated_at (prev+1), NOT to now. This is a one-time maintenance
  // rewrite: bumping to now would reorder legacy sessions to the top of every recency view
  // (sqlite-history.ts orders by transcript_updated_at). But the watermark must still change,
  // because it is the in-flight projection-rebuild worker's stale-snapshot key
  // (session-transcript-projection-rebuild.ts sourceSnapshotMatches) and seq is unchanged here;
  // leaving it identical would let a concurrent worker apply a stale pre-rewrite index. A null
  // watermark (session absent from recency views) has no recency to preserve, so touch to now.
  const currentUpdatedAt = readTranscriptMutationStateInTransaction(database, sessionId).updatedAt;
  if (currentUpdatedAt === null) {
    touchTranscriptMutationInTransaction(database, sessionId);
  } else {
    advanceTranscriptMutationAtInTransaction(database, sessionId, currentUpdatedAt, {
      strictly: true,
    });
  }
  scheduleTranscriptProjectionReconcile(database, sessionId, !rebuildSynchronously, {});
}

function readIdempotencyKeyOwner(
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
  const identity = readIdempotencyKeyOwner(database, scope.sessionId, idempotencyKey);
  return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
}

export function readTranscriptMessageByScopedIdempotencyKey(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
  lookup: TranscriptMessageAppendOptions<unknown>["idempotencyLookup"],
): { messageId: string; message: unknown } | undefined {
  if (lookup !== "scan-assistant") {
    return readTranscriptMessageByIdempotencyKey(database, scope, idempotencyKey);
  }
  const found = findTranscriptEventInDatabase(database, scope.sessionId, (event) => {
    const message = readTranscriptEventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === idempotencyKey;
  });
  if (!found) {
    return undefined;
  }
  const message = readTranscriptEventMessage(found.event);
  return message
    ? { messageId: readTranscriptEventId(found.event) ?? idempotencyKey, message }
    : undefined;
}

export function readTranscriptMessageByEventId(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByEventId(database, scope.sessionId, eventId);
  return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
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
  return { messageId: identity.eventId, message: event.message };
}

function readTranscriptEventIdentity(event: unknown) {
  if (!isRecord(event)) {
    return undefined;
  }
  const eventId = typeof event.id === "string" && event.id.trim() ? event.id.trim() : undefined;
  return eventId
    ? {
        eventId,
        eventType: typeof event.type === "string" ? event.type : null,
        parentId: typeof event.parentId === "string" ? event.parentId : null,
        messageIdempotencyKey: readMessageIdempotencyKey(event.message),
      }
    : undefined;
}

function canonicalizeTranscriptEventMedia(event: TranscriptEvent): TranscriptEvent {
  if (!isRecord(event)) {
    return event;
  }
  const message = event.message;
  if (event.type !== "message" || !isRecord(message)) {
    return event;
  }
  const canonical = canonicalizePersistedUserMessageMedia(message);
  return canonical.changed ? { ...event, message: canonical.message } : event;
}

export function readMessageIdempotencyKey(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }
  const value = message.idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEventTimestamp(event: unknown): number | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const value = event.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function redactTranscriptMessageForStorage<TMessage>(
  message: TMessage,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "config">,
): TMessage {
  return isTranscriptAgentMessage(message)
    ? (redactTranscriptMessage(
        message,
        options.config,
        getCodeModeSourceAppend(options),
      ) as TMessage)
    : redactSecrets(message);
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === "string";
}
