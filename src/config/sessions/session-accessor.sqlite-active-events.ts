// Bounded reads over the materialized active transcript path. Dirty paths
// schedule maintenance and fail fast; clean reads deserialize selected rows.
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_generations"
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

const VISIBLE_MESSAGE_CURSOR_VERSION = 1;
const DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES = 1_000;
const DEFAULT_VISIBLE_MESSAGE_MAX_BYTES = 1_000_000;
const MAX_VISIBLE_MESSAGE_MAX_MESSAGES = 10_000;
const MAX_VISIBLE_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;

type VisibleMessageCursor = {
  agentId: string;
  generation: string;
  lastEventSeq: number;
  lastMessagePosition: number;
  sessionId: string;
  version: typeof VISIBLE_MESSAGE_CURSOR_VERSION;
};

export type SessionTranscriptMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

export type SessionTranscriptMessageEventPage = {
  events: SessionTranscriptMessageEvent[];
  totalMessages: number;
};

export type SessionTranscriptMessageAnchorPage = SessionTranscriptMessageEventPage & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

export class SessionTranscriptProjectionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session transcript projection is rebuilding: ${sessionId}`);
    this.name = "SessionTranscriptProjectionUnavailableError";
  }
}

export function isSessionTranscriptProjectionUnavailableError(
  error: unknown,
): error is SessionTranscriptProjectionUnavailableError {
  return error instanceof SessionTranscriptProjectionUnavailableError;
}

type CurrentProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

const EMPTY_PROJECTION_STATE: SessionTranscriptProjectionState = {
  activeEventCount: 0,
  activeMessageCount: 0,
  indexedSeq: -1,
  leafEventId: null,
  needsRebuild: false,
};

function getActiveTranscriptKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
}

function normalizeVisibleMessageLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return resolved;
}

function encodeVisibleMessageCursor(cursor: VisibleMessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseVisibleMessageCursor(value: string): VisibleMessageCursor | undefined {
  // The cursor is a continuation hint, not an authorization token. Every field
  // is revalidated against the current scope, generation, and projection.
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<VisibleMessageCursor>;
    if (
      parsed.version !== VISIBLE_MESSAGE_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isSafeInteger(parsed.lastEventSeq) ||
      (parsed.lastEventSeq ?? -2) < -1 ||
      !Number.isSafeInteger(parsed.lastMessagePosition) ||
      (parsed.lastMessagePosition ?? -2) < -1 ||
      (parsed.lastEventSeq === -1) !== (parsed.lastMessagePosition === -1)
    ) {
      return undefined;
    }
    return parsed as VisibleMessageCursor;
  } catch {
    return undefined;
  }
}

function bootstrapVisibleMessageCursor(
  projection: CurrentProjection,
  generation: string,
): VisibleMessageCursor {
  return {
    agentId: projection.resolved.agentId,
    generation,
    lastEventSeq: -1,
    lastMessagePosition: -1,
    sessionId: projection.resolved.sessionId,
    version: VISIBLE_MESSAGE_CURSOR_VERSION,
  };
}

function readProjectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { latestSeq: number; state?: SessionTranscriptProjectionState } | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getActiveTranscriptKysely(database)
      .selectFrom("transcript_events as latest")
      .leftJoin("session_transcript_index_state as state", "state.session_id", "latest.session_id")
      .select([
        "latest.seq as latest_seq",
        "state.active_event_count",
        "state.active_message_count",
        "state.indexed_seq",
        "state.leaf_event_id",
        "state.needs_rebuild",
      ])
      .where("latest.session_id", "=", sessionId)
      .orderBy("latest.seq", "desc")
      .limit(1),
  );
  if (!row) {
    return undefined;
  }
  return {
    latestSeq: row.latest_seq,
    ...(typeof row.indexed_seq === "number"
      ? {
          state: {
            activeEventCount: row.active_event_count ?? 0,
            activeMessageCount: row.active_message_count ?? 0,
            indexedSeq: row.indexed_seq,
            leafEventId: row.leaf_event_id,
            needsRebuild: row.needs_rebuild !== 0,
          },
        }
      : {}),
  };
}

function withCurrentProjectionSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (projection: CurrentProjection) => T,
): T {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const database = openOpenClawAgentDatabase(databaseOptions);
  const result = runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const snapshot = readProjectionSnapshot(database, resolved.sessionId);
      if (!snapshot) {
        return {
          kind: "value" as const,
          value: read({ database, resolved, state: EMPTY_PROJECTION_STATE }),
        };
      }
      if (
        snapshot.state &&
        !snapshot.state.needsRebuild &&
        snapshot.state.indexedSeq === snapshot.latestSeq
      ) {
        return {
          kind: "value" as const,
          value: read({ database, resolved, state: snapshot.state }),
        };
      }
      return { kind: "unavailable" as const };
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.history.read",
    },
  );
  if (result.kind === "value") {
    return result.value;
  }
  // Request latency never scales with transcript size. The maintenance owner
  // rebuilds after this stack unwinds; callers return a retryable response.
  startSessionTranscriptIndexReconcile({
    ...databaseOptions,
    preferredSessionId: resolved.sessionId,
  });
  throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
}

function parseMessageEventRow(row: {
  event_json: string;
  message_position: number | null;
}): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    // Gateway cursors use the visible-message ordinal, matching the JSONL index.
    // Raw event seq includes headers/control rows and would make pages overlap.
    seq: row.message_position + 1,
  };
}

function readMessageRange(
  projection: CurrentProjection,
  start: number,
  endExclusive: number,
): SessionTranscriptMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const db = getActiveTranscriptKysely(projection.database);
  return executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.message_position", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is not", null)
      .where("active.message_position", ">=", start)
      .where("active.message_position", "<", endExclusive)
      .orderBy("active.message_position", "asc"),
  ).rows.map(parseMessageEventRow);
}

/** Reads every message event on the active path. Full callers remain intentionally O(output). */
export function readSessionTranscriptMessageEvents(
  scope: SessionTranscriptReadScope,
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readMessageRange(projection, 0, projection.state.activeMessageCount),
  );
}

/** Reads one append-stable forward page from the materialized active-message projection. */
export function readSessionTranscriptVisibleMessageDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptVisibleMessageDeltaLimits = {},
): SessionTranscriptVisibleMessageDeltaResult {
  const maxMessages = normalizeVisibleMessageLimit(
    limits.maxMessages,
    DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    "maxMessages",
  );
  const maxBytes = normalizeVisibleMessageLimit(
    limits.maxBytes,
    DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
    MAX_VISIBLE_MESSAGE_MAX_BYTES,
    "maxBytes",
  );
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const generation = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_generations")
        .select("generation")
        .where("session_id", "=", projection.resolved.sessionId),
    )?.generation;
    if (!generation) {
      return { kind: "missing" };
    }

    const initialCursor = bootstrapVisibleMessageCursor(projection, generation);
    const reset = (
      reason: Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "reset" }>["reason"],
    ) => ({
      kind: "reset" as const,
      cursor: encodeVisibleMessageCursor(initialCursor),
      reason,
    });
    const cursor =
      limits.cursor !== undefined ? parseVisibleMessageCursor(limits.cursor) : initialCursor;
    if (!cursor) {
      return reset("invalid_cursor");
    }
    if (
      cursor.agentId !== projection.resolved.agentId ||
      cursor.sessionId !== projection.resolved.sessionId
    ) {
      return reset("scope_mismatch");
    }
    if (cursor.generation !== generation) {
      return reset("generation_mismatch");
    }

    let startPosition = 0;
    if (cursor.lastEventSeq >= 0) {
      const anchor = executeSqliteQueryTakeFirstSync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events")
          .select("message_position")
          .where("session_id", "=", projection.resolved.sessionId)
          .where("event_seq", "=", cursor.lastEventSeq)
          .where("message_position", "is not", null),
      );
      if (anchor?.message_position === null || anchor?.message_position === undefined) {
        return reset("anchor_missing");
      }
      if (anchor.message_position !== cursor.lastMessagePosition) {
        return reset("anchor_moved");
      }
      startPosition = anchor.message_position + 1;
    }

    const metadata = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select([
          "active.event_seq",
          "active.message_position",
          /* kysely-allow-raw: SQLite byte length avoids fetching or parsing excluded JSON. */
          sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`.as("serialized_bytes"),
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("active.message_position", "is not", null)
        .where("active.message_position", ">=", startPosition)
        .orderBy("active.message_position", "asc")
        .limit(maxMessages + 1),
    ).rows;

    let serializedBytes = 0;
    let selectedCount = 0;
    for (const row of metadata) {
      if (selectedCount >= maxMessages || serializedBytes + row.serialized_bytes > maxBytes) {
        break;
      }
      serializedBytes += row.serialized_bytes;
      selectedCount += 1;
    }
    const selected = metadata.slice(0, selectedCount);
    const lastEventSeq = selected.at(-1)?.event_seq ?? cursor.lastEventSeq;
    const lastMessagePosition = selected.at(-1)?.message_position ?? cursor.lastMessagePosition;
    const rows =
      selectedCount === 0
        ? []
        : executeSqliteQuerySync(
            projection.database.db,
            db
              .selectFrom("session_transcript_active_events as active")
              .innerJoin("transcript_events as event", (join) =>
                join
                  .onRef("event.session_id", "=", "active.session_id")
                  .onRef("event.seq", "=", "active.event_seq"),
              )
              .leftJoin("session_transcript_active_events as parent_active", (join) =>
                join
                  .onRef("parent_active.session_id", "=", "active.session_id")
                  .on((eb) =>
                    eb("parent_active.active_position", "=", eb("active.active_position", "-", 1)),
                  ),
              )
              .leftJoin("transcript_event_identities as parent_identity", (join) =>
                join
                  .onRef("parent_identity.session_id", "=", "parent_active.session_id")
                  .onRef("parent_identity.seq", "=", "parent_active.event_seq"),
              )
              .select([
                "active.event_seq",
                "active.message_position",
                "event.event_json",
                "parent_identity.event_id as parent_id",
              ])
              .where("active.session_id", "=", projection.resolved.sessionId)
              .where("active.message_position", ">=", startPosition)
              .where("active.message_position", "<=", lastMessagePosition)
              .orderBy("active.message_position", "asc"),
          ).rows.map((row) => {
            if (row.message_position === null) {
              throw new Error("Active transcript message row is missing its message position");
            }
            return {
              event: JSON.parse(row.event_json) as TranscriptEvent,
              eventSeq: row.event_seq,
              parentId: row.parent_id,
              seq: row.message_position + 1,
            };
          });
    const requiredBytes =
      selectedCount === 0 && metadata[0] ? metadata[0].serialized_bytes : undefined;
    return {
      kind: "page",
      cursor: encodeVisibleMessageCursor({ ...cursor, lastEventSeq, lastMessagePosition }),
      events: rows,
      hasMore: selectedCount < metadata.length,
      ...(requiredBytes !== undefined ? { requiredBytes } : {}),
      serializedBytes,
    };
  });
}

/** Reads a bounded active-path tail while preserving transcript line and byte caps. */
export function readRecentSessionTranscriptMessageEvents(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxLines: number; maxMessages: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
    );
    const maxLines = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxLines) ? options.maxLines : 0),
    );
    if (maxMessages === 0 || maxLines === 0) {
      return { events: [], totalMessages: projection.state.activeMessageCount };
    }
    const maxBytes = Math.max(
      1024,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024),
    );
    const db = getActiveTranscriptKysely(projection.database);
    const rows = executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(["active.event_seq", "active.message_position", "event.event_json"])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .orderBy("active.active_position", "desc")
        .limit(maxLines),
    ).rows;
    const selected: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
      const rowBytes = Buffer.byteLength(row.event_json) + 1;
      if (selected.length > 0 && bytes + rowBytes > maxBytes) {
        break;
      }
      selected.push(row);
      bytes += rowBytes;
    }
    const events = selected
      .toReversed()
      .filter((row) => row.message_position !== null)
      .map(parseMessageEventRow);
    return {
      events: events.length > maxMessages ? events.slice(-maxMessages) : events,
      totalMessages: projection.state.activeMessageCount,
    };
  });
}

/** Reads one tail-relative message page with index range predicates, never OFFSET scanning. */
export function readSessionTranscriptMessageEventPage(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; offset: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const totalMessages = projection.state.activeMessageCount;
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
      totalMessages,
    );
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
    );
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - maxMessages);
    return {
      events: readMessageRange(projection, start, endExclusive),
      totalMessages,
    };
  });
}

/** Counts active-path messages from the transactionally maintained watermark. */
export function readSessionTranscriptMessageEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(scope, (projection) => projection.state.activeMessageCount);
}

/** Reads one active message by event id without materializing sibling rows. */
export function readSessionTranscriptMessageEventById(
  scope: SessionTranscriptReadScope,
  messageId: string,
): SessionTranscriptMessageEvent | undefined {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const row = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(["active.message_position", "event.event_json"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", messageId)
        .where("active.message_position", "is not", null),
    );
    return row ? parseMessageEventRow(row) : undefined;
  });
}

/** Reads a centered active-message page plus one older context row for split rendering. */
export function readSessionTranscriptMessageAnchorPage(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; messageId: string },
): SessionTranscriptMessageAnchorPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const anchor = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.message_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", options.messageId)
        .where("active.message_position", "is not", null),
    );
    const totalMessages = projection.state.activeMessageCount;
    if (anchor?.message_position === null || anchor?.message_position === undefined) {
      return {
        events: [],
        found: false,
        hasOverreadContext: false,
        offset: 0,
        totalMessages,
      };
    }
    const pageSize = Math.max(
      1,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1),
    );
    const newerMessages = Math.floor(pageSize / 2);
    const olderMessages = pageSize - newerMessages - 1;
    const latestStart = Math.max(0, totalMessages - pageSize);
    const start = Math.min(Math.max(0, anchor.message_position - olderMessages), latestStart);
    const endExclusive = Math.min(totalMessages, start + pageSize);
    const readStart = Math.max(0, start - 1);
    return {
      events: readMessageRange(projection, readStart, endExclusive),
      found: true,
      hasOverreadContext: readStart < start,
      offset: totalMessages - endExclusive,
      totalMessages,
    };
  });
}
