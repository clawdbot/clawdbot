import { parseStrictTimestampStringMs } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
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
  deleteSqliteTranscriptEventsInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  readTranscriptGenerationInTransaction,
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
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
    dedupeByMessageIdempotency?: boolean;
    onProjectionReconcileNeeded?: () => void;
    scheduleProjectionReconcile?: boolean;
    touchMutation?: boolean;
  } = {},
): boolean {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt);
  ensureTranscriptGenerationInTransaction(database, scope.sessionId);
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
  if (options.touchMutation !== false) {
    touchTranscriptMutationInTransaction(database, scope.sessionId);
  }
  const projectionNeedsRebuild = indexAppendedTranscriptEventInTransaction(database.db, {
    sessionId: scope.sessionId,
    seq,
    event,
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
  indexAppendedTranscriptEventInTransaction(database.db, {
    sessionId: scope.sessionId,
    seq,
    event,
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
): void {
  const previousGeneration = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  const deleted = deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
  if (events.length === 0) {
    if (deleted || previousGeneration) {
      rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      touchTranscriptMutationInTransaction(database, resolved.sessionId);
    }
    return;
  }
  ensureTranscriptSessionRoot(database, resolved, readEventTimestamp(events[0]) ?? Date.now());
  if (deleted || previousGeneration) {
    rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
  } else {
    ensureTranscriptGenerationInTransaction(database, resolved.sessionId);
  }
  let seq = 0;
  const seenEventIds = new Set<string>();
  const seenMessageIdempotencyKeys = new Set<string>();
  for (const event of events) {
    if (
      appendTranscriptEventRowInTransaction(database, resolved, event, seq, {
        seenEventIds,
        seenMessageIdempotencyKeys,
      })
    ) {
      seq += 1;
    }
  }
  if (deleted || seq > 0) {
    touchTranscriptMutationInTransaction(database, resolved.sessionId);
    reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
  }
}

export function readTranscriptIdentityByEventId(
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
  return parseStrictTimestampStringMs(value);
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
