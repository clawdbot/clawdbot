// Bounded reads over the materialized active transcript path. Dirty paths
// schedule maintenance and fail fast; clean reads deserialize selected rows.
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
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

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
