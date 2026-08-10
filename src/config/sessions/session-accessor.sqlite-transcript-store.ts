import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  TranscriptEvent,
  TranscriptMessageAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import {
  findSqliteTranscriptEventInDatabase,
  loadSqliteTranscriptEventsFromDatabase,
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  deleteSqliteTranscriptEventsInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  deleteSessionTranscriptIndexInTransaction,
  indexAppendedTranscriptEventInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import {
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import { resolveVisibleTranscriptAppendParentId } from "./transcript-visible-events.js";

export function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: {
    allowStoredAlias?: boolean;
    dedupeByMessageIdempotency?: boolean;
    onProjectionReconcileNeeded?: () => void;
    scheduleProjectionReconcile?: boolean;
    touchMutation?: boolean;
  } = {},
): boolean {
  const persistedEvent = canonicalizeTranscriptEventMedia(event);
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(persistedEvent) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt, {
    allowStoredAlias: options.allowStoredAlias === true,
  });
  ensureTranscriptGenerationInTransaction(database, scope.sessionId);
  const identity = readTranscriptEventIdentity(persistedEvent);
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
      event_json: JSON.stringify(persistedEvent),
      created_at: createdAt,
    }),
  );
  if (options.touchMutation !== false) {
    touchTranscriptMutationInTransaction(database, scope.sessionId);
  }
  const projectionNeedsRebuild = indexAppendedTranscriptEventInTransaction(database.db, {
    sessionId: scope.sessionId,
    seq,
    event: persistedEvent,
    eventId: identity?.eventId ?? null,
    createdAt,
  });
  if (projectionNeedsRebuild) {
    options.onProjectionReconcileNeeded?.();
  }
  if (!identity) {
    scheduleTranscriptProjectionReconcile(database, scope, projectionNeedsRebuild, options);
    return true;
  }
  // Caller-checked appends may retain a duplicate key in the payload, but the
  // identity index can point at only one row.
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
  scheduleTranscriptProjectionReconcile(database, scope, projectionNeedsRebuild, options);
  return true;
}

function scheduleTranscriptProjectionReconcile(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  projectionNeedsRebuild: boolean,
  options: { scheduleProjectionReconcile?: boolean },
): void {
  if (!projectionNeedsRebuild || options.scheduleProjectionReconcile === false) {
    return;
  }
  // setImmediate in the reconcile owner runs only after this synchronous
  // SQLite transaction commits, keeping full-tree work off the writer stack.
  startSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: database.path,
    preferredSessionId: scope.sessionId,
  });
}

export function appendTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
): number {
  let appended = 0;
  let projectionNeedsRebuild = false;
  for (const event of events) {
    if (
      appendTranscriptEventInTransaction(database, scope, event, {
        onProjectionReconcileNeeded: () => {
          projectionNeedsRebuild = true;
        },
        scheduleProjectionReconcile: false,
        touchMutation: false,
      })
    ) {
      appended += 1;
    }
  }
  if (appended > 0) {
    touchTranscriptMutationInTransaction(database, scope.sessionId);
    scheduleTranscriptProjectionReconcile(database, scope, projectionNeedsRebuild, {});
  }
  return appended;
}

function appendTranscriptEventRowInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  seq: number,
  state: { seenEventIds: Set<string>; seenMessageIdempotencyKeys: Set<string> },
  createdAtOverride?: number,
): boolean {
  const persistedEvent = canonicalizeTranscriptEventMedia(event);
  const db = getSessionKysely(database.db);
  const createdAt = createdAtOverride ?? readEventTimestamp(persistedEvent) ?? Date.now();
  const identity = readTranscriptEventIdentity(persistedEvent);
  if (identity && state.seenEventIds.has(identity.eventId)) {
    return false;
  }
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq,
      event_json: JSON.stringify(persistedEvent),
      created_at: createdAt,
    }),
  );
  indexAppendedTranscriptEventInTransaction(database.db, {
    sessionId: scope.sessionId,
    seq,
    event: persistedEvent,
    eventId: identity?.eventId ?? null,
    createdAt,
  });
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

export function ensureTranscriptHeader(
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
    createSessionTranscriptHeader({ cwd, sessionId: scope.sessionId }),
  );
  ensureTranscriptSessionRoot(database, scope, now);
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
    // Fall through to the tolerant full-tree resolver.
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
  const preservedTranscriptUpdatedAt =
    options.preserveSessionWindowRecency === true
      ? readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt
      : undefined;
  const previousGeneration = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  const deleted = deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
  if (events.length === 0) {
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
  let seq = 0;
  const seenEventIds = new Set<string>();
  const seenMessageIdempotencyKeys = new Set<string>();
  for (const [eventIndex, event] of events.entries()) {
    if (
      appendTranscriptEventRowInTransaction(
        database,
        resolved,
        event,
        seq,
        {
          seenEventIds,
          seenMessageIdempotencyKeys,
        },
        options.createdAtByIndex?.[eventIndex],
      )
    ) {
      seq += 1;
    }
  }
  if (deleted || seq > 0) {
    recordTranscriptReplacementMutation(database, resolved.sessionId, preservedTranscriptUpdatedAt);
    reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
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
  reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
}

// Text-only transcript repair: rewrites event_json for specific rows in place.
// Preserves seq, created_at, session_key, and session activity recency; rotates the transcript
// generation and rebuilds the index so readers/search pick up the new text.
export function updateSqliteTranscriptEventJsonInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  updates: ReadonlyArray<{ seq: number; eventJson: string }>,
): void {
  if (updates.length === 0) {
    return;
  }
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
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
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
}

export function readTranscriptIdentityByEventId(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string,
): { eventId: string; parentId: string | null; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "parent_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId),
  );
  return row ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq } : undefined;
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
  const found = findSqliteTranscriptEventInDatabase(database, scope.sessionId, (event) => {
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
  return eventId
    ? {
        eventId,
        eventType: typeof record.type === "string" ? record.type : null,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
        messageIdempotencyKey: readMessageIdempotencyKey(record.message),
      }
    : undefined;
}

function canonicalizeTranscriptEventMedia(event: TranscriptEvent): TranscriptEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return event;
  }
  const record = event as Record<string, unknown>;
  const message = record.message;
  if (
    record.type !== "message" ||
    !message ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return event;
  }
  const canonical = canonicalizePersistedUserMessageMedia(message);
  return canonical.changed ? { ...record, message: canonical.message } : event;
}

export function readMessageIdempotencyKey(message: unknown): string | null {
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

export function redactTranscriptMessageForStorage<TMessage>(
  message: TMessage,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "config">,
): TMessage {
  return isTranscriptAgentMessage(message)
    ? (redactTranscriptMessage(message, options.config) as TMessage)
    : redactSecrets(message);
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}
