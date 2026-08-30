import { sql } from "kysely";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptProjectionGeneration,
  readVisibleMessageRange,
  readVisibleTranscriptStats,
  resolvePostResetVisibleStart,
  resolveVisibleMessagePositionRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  createVisibleMessageCursor,
  encodeVisibleMessageCursor,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
  parseVisibleMessageCursor,
} from "./session-accessor.sqlite-visible-cursor.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
export { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
export {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptProjectionUnavailableError,
} from "./session-transcript-projection-error.js";

export type SessionTranscriptMessageEvent = {
  event: TranscriptEvent;
  eventSeq: number;
  seq: number;
  displayPosition?: TranscriptDisplayPosition;
};

export type SessionTranscriptMessageEventPage = {
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  events: SessionTranscriptMessageEvent[];
  totalMessages: number;
};

export type SessionTranscriptMessageAnchorPage = SessionTranscriptMessageEventPage & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

export type SessionTranscriptBoundedMessageTailPage = SessionTranscriptMessageEventPage & {
  // `events` may remain sparse for salvage callers; this count marks the
  // authoritative newest suffix before the first byte-budget omission.
  newestContiguousEventCount: number;
  scannedMessages: number;
  serializedBytes: number;
  snapshot: {
    generation?: string;
    indexedSeq: number;
  };
};

function parseMessageEventRow(row: {
  event_seq: number;
  event_json: string;
  message_position: number | null;
}): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    eventSeq: row.event_seq,
    // Gateway cursors use the visible-message ordinal, matching the JSONL index.
    // Raw event seq includes headers/control rows and would make pages overlap.
    seq: row.message_position + 1,
  };
}

/** Reads every message event on the active path. Full callers remain intentionally O(output). */
export function readSessionTranscriptMessageEvents(
  scope: SessionTranscriptReadScope,
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    return readVisibleMessageRange(projection, 0, visible.total);
  });
}

/** Classifies one entry against the authoritative active path and leaf. */
export function readSessionTranscriptActivePathEntryRelation(
  scope: SessionTranscriptReadScope,
  entryId: string | null,
): "exact" | "ancestor" | "off-path" {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    if (projection.state.leafEventId === entryId || entryId === null) {
      return projection.state.leafEventId === entryId ? "exact" : "off-path";
    }
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
        .select("identity.seq")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", entryId)
        .limit(1),
    );
    return row ? "ancestor" : "off-path";
  });
}

/** Reads a bounded context tail, preserving control facts but excluding display-only messages. */
export function readRecentSessionTranscriptActiveEvents(
  scope: SessionTranscriptReadScope,
  maxEvents: number,
): TranscriptEvent[] {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const limit = Math.max(0, Math.floor(Number.isFinite(maxEvents) ? maxEvents : 0));
    if (limit === 0) {
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
        .select("event.event_json")
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("active.context_eligible", "=", 1)
        .orderBy("active.active_position", "desc")
        .limit(limit),
    )
      .rows.toReversed()
      .map((row) => JSON.parse(row.event_json) as TranscriptEvent);
  });
}

/** Reads logical transcript event count and JSONL byte size. */
export function readSessionTranscriptActiveStats(scope: SessionTranscriptReadScope): {
  eventCount: number;
  sizeBytes: number;
} {
  return withCurrentProjectionSnapshot(scope, readVisibleTranscriptStats);
}

/** Reads one append-stable forward page from the materialized active-message projection. */
export function readSessionTranscriptVisibleMessageDeltaCore(
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
    const transcriptFence = resolveSqliteSessionTranscriptReadFence({
      database: projection.database,
      ...projection.resolved,
    });
    const generation = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", projection.resolved.sessionId),
    )?.generation;
    if (!generation) {
      return { kind: "missing" };
    }

    const initialCursor = createVisibleMessageCursor({
      agentId: projection.resolved.agentId,
      generation,
      sessionId: projection.resolved.sessionId,
    });
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
    if (
      transcriptFence !== undefined &&
      cursor.lastMessagePosition >= transcriptFence.beforeActiveMessagePosition
    ) {
      throw new SessionTranscriptReadFenceError(
        "Transcript read cursor has crossed the current-turn admission fence",
      );
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
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("active.message_position", "is not", null)
        .where("active.message_position", ">=", startPosition)
        .$if(transcriptFence !== undefined, (query) =>
          query.where("active.message_position", "<", transcriptFence!.beforeActiveMessagePosition),
        )
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
    const visible = resolveVisibleMessagePositions(projection);
    const maxMessages = Math.min(
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)),
    );
    const maxLines = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxLines) ? options.maxLines : 0),
    );
    if (maxMessages === 0 || maxLines === 0) {
      return {
        activeLeafEntryId: projection.state.leafEventId,
        events: [],
        totalMessages: visible.total,
      };
    }
    const maxBytes = Math.max(
      1024,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024),
    );
    const candidates = readVisibleMessageRange(
      projection,
      Math.max(0, visible.total - maxLines),
      visible.total,
    );
    const selected: SessionTranscriptMessageEvent[] = [];
    let bytes = 0;
    for (const event of candidates.toReversed()) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event.event)) + 1;
      if (
        selected.length >= maxMessages ||
        (selected.length > 0 && bytes + eventBytes > maxBytes)
      ) {
        break;
      }
      selected.push(event);
      bytes += eventBytes;
    }
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: selected.toReversed(),
      totalMessages: visible.total,
    };
  });
}

/** Reads one tail-relative message page with index range predicates, never OFFSET scanning. */
export function readSessionTranscriptMessageEventPage(
  scope: SessionTranscriptReadScope,
  options: { excludeResetCarryover?: boolean; maxMessages: number; offset: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    // What the reset retained sits at the head of the visible window, so starting
    // after it leaves exactly the messages that boundary admitted.
    const firstVisible = options.excludeResetCarryover
      ? resolvePostResetVisibleStart(projection)
      : 0;
    const totalMessages = Math.max(0, visible.total - firstVisible);
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
      totalMessages,
    );
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
    );
    const endExclusive = firstVisible + Math.max(0, totalMessages - offset);
    const start = Math.max(firstVisible, endExclusive - maxMessages);
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: readVisibleMessageRange(projection, start, endExclusive),
      totalMessages,
    };
  });
}

/** Reads a tail page whose materialized event payloads fit a hard byte budget. */
export function readSessionTranscriptBoundedMessageTailPage(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxMessages: number; offset: number },
): SessionTranscriptBoundedMessageTailPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    const snapshot = {
      generation: readTranscriptProjectionGeneration(projection),
      indexedSeq: projection.state.indexedSeq,
    };
    const totalMessages = visible.total;
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
      totalMessages,
    );
    const maxMessages = Math.min(
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)),
    );
    const maxBytes = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 0),
    );
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - maxMessages);
    const positions = resolveVisibleMessagePositionRange(projection, start, endExclusive);
    if (positions.length === 0 || maxBytes === 0) {
      return {
        activeLeafEntryId: projection.state.leafEventId,
        events: [],
        newestContiguousEventCount: 0,
        scannedMessages: positions.length,
        serializedBytes: 0,
        snapshot,
        totalMessages,
      };
    }
    const db = getActiveTranscriptKysely(projection.database);
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
          "active.message_position",
          /* kysely-allow-raw: byte budget covers the exact newline-terminated JSON event. */
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("active.message_position", "in", positions)
        .orderBy("active.message_position", "desc"),
    ).rows;
    if (metadata.length !== positions.length) {
      throw new Error("Active transcript bounded message page is incomplete");
    }
    const selectedPositions: number[] = [];
    let newestContiguousEventCount: number | undefined;
    let serializedBytes = 0;
    for (const row of metadata) {
      if (row.message_position === null || serializedBytes + row.serialized_bytes > maxBytes) {
        newestContiguousEventCount ??= selectedPositions.length;
        continue;
      }
      selectedPositions.push(row.message_position);
      serializedBytes += row.serialized_bytes;
    }
    const events =
      selectedPositions.length === 0
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
              .select(["active.event_seq", "active.message_position", "event.event_json"])
              .where("active.session_id", "=", projection.resolved.sessionId)
              .where("active.message_position", "in", selectedPositions)
              .orderBy("active.message_position", "asc"),
          ).rows.map(parseMessageEventRow);
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events,
      newestContiguousEventCount: newestContiguousEventCount ?? selectedPositions.length,
      scannedMessages: positions.length,
      serializedBytes,
      snapshot,
      totalMessages,
    };
  });
}
