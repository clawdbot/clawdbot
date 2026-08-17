import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type {
  SessionTranscriptMessageAnchorPage,
  SessionTranscriptMessageEvent,
  SessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  readVisibleMessageRange,
  resolveVisibleMessagePositionRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";

type VisibleHistoryBoundary = {
  displayPosition: number;
  eventId: string;
  eventSeq: number;
  messagePosition: number;
  serializedBytes: number;
};

type VisibleHistoryProjection = {
  boundaries: VisibleHistoryBoundary[];
  total: number;
};

function resolveVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
): VisibleHistoryProjection {
  const visibleMessages = resolveVisibleMessagePositions(projection);
  const db = getActiveTranscriptKysely(projection.database);
  const rows = executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "identity.event_id",
        "identity.event_type",
        "identity.seq",
        /* kysely-allow-raw: history byte caps include each event's JSONL newline. */
        sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`.as("serialized_bytes"),
      ])
      .select((eb) =>
        eb
          .selectFrom("session_transcript_active_events as next")
          .select((nextEb) => nextEb.fn.min<number>("next.message_position").as("position"))
          .whereRef("next.session_id", "=", "active.session_id")
          .whereRef("next.active_position", ">", "active.active_position")
          .where("next.message_position", "is not", null)
          .as("next_message_position"),
      )
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "in", ["compaction", "reset"])
      .orderBy("active.active_position", "asc"),
  ).rows;
  const latestBoundaryIsReset = rows.at(-1)?.event_type === "reset";
  const visibleRows = latestBoundaryIsReset ? rows.slice(-1) : rows;
  let priorBoundaries = 0;
  const boundaries = visibleRows.map((row): VisibleHistoryBoundary => {
    const messagePosition = latestBoundaryIsReset
      ? visibleMessages.kept.length
      : Math.min(
          row.next_message_position ?? projection.state.activeMessageCount,
          visibleMessages.total,
        );
    return {
      displayPosition: messagePosition + priorBoundaries++,
      eventId: row.event_id,
      eventSeq: row.seq,
      messagePosition,
      serializedBytes: row.serialized_bytes,
    };
  });
  return {
    boundaries,
    total: visibleMessages.total + boundaries.length,
  };
}

function resolveVisibleHistoryRange(
  history: VisibleHistoryProjection,
  start: number,
  endExclusive: number,
) {
  const boundedStart = Math.min(Math.max(0, start), history.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), history.total);
  const selectedBoundaries = history.boundaries.filter(
    (boundary) => boundary.displayPosition >= boundedStart && boundary.displayPosition < boundedEnd,
  );
  const boundaries = new Map(
    selectedBoundaries.map((boundary) => [boundary.displayPosition, boundary] as const),
  );
  const boundariesBefore = history.boundaries.filter(
    (boundary) => boundary.displayPosition < boundedStart,
  ).length;
  const messageStart = boundedStart - boundariesBefore;
  const messageEnd = messageStart + boundedEnd - boundedStart - selectedBoundaries.length;
  return { boundedEnd, boundedStart, boundaries, messageEnd, messageStart };
}

function readBoundaryEvents(
  projection: CurrentTranscriptProjection,
  boundaries: Iterable<VisibleHistoryBoundary>,
): Map<number, TranscriptEvent> {
  const eventSeqs = Array.from(boundaries, (boundary) => boundary.eventSeq);
  const [firstSeq] = eventSeqs;
  const lastSeq = eventSeqs.at(-1);
  if (firstSeq === undefined || lastSeq === undefined) {
    return new Map();
  }
  const db = getActiveTranscriptKysely(projection.database);
  return new Map(
    executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(["event.seq", "event.event_json"])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_type", "in", ["compaction", "reset"])
        .where("identity.seq", ">=", firstSeq)
        .where("identity.seq", "<=", lastSeq),
    ).rows.map((row) => [row.seq, JSON.parse(row.event_json) as TranscriptEvent]),
  );
}

function readVisibleHistoryRange(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
  history = resolveVisibleHistoryProjection(projection),
): SessionTranscriptMessageEvent[] {
  const { boundedEnd, boundedStart, boundaries, messageEnd, messageStart } =
    resolveVisibleHistoryRange(history, start, endExclusive);
  if (boundedEnd <= boundedStart) {
    return [];
  }
  const messages = readVisibleMessageRange(projection, messageStart, messageEnd);
  const boundaryEvents = readBoundaryEvents(projection, boundaries.values());
  let messageIndex = 0;
  const events: SessionTranscriptMessageEvent[] = [];
  for (let displayPosition = boundedStart; displayPosition < boundedEnd; displayPosition += 1) {
    const boundary = boundaries.get(displayPosition);
    if (boundary) {
      const event = boundaryEvents.get(boundary.eventSeq);
      if (event) {
        events.push({ event, seq: displayPosition + 1 });
      }
      continue;
    }
    const message = messages[messageIndex++];
    if (message) {
      events.push({ event: message.event, seq: displayPosition + 1 });
    }
  }
  return events;
}

function resolveRecentHistoryStart(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
  history: VisibleHistoryProjection,
  maxBytes: number,
  maxMessages: number,
): number {
  const { boundedEnd, boundedStart, boundaries, messageEnd, messageStart } =
    resolveVisibleHistoryRange(history, start, endExclusive);
  // No result can include more than maxMessages events, so older metadata would
  // only add SQLite bindings and synchronous work before the backward scan stops.
  const metadataStart = Math.max(messageStart, messageEnd - maxMessages);
  const positions = resolveVisibleMessagePositionRange(projection, metadataStart, messageEnd);
  const db = getActiveTranscriptKysely(projection.database);
  const messageBytes = new Map(
    positions.length === 0
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
            .select([
              "active.message_position",
              /* kysely-allow-raw: excluded history payloads must not be fetched or parsed. */
              sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`.as("serialized_bytes"),
            ])
            .where("active.session_id", "=", projection.resolved.sessionId)
            .where("active.message_position", "in", positions),
        ).rows.flatMap((row) =>
          row.message_position === null
            ? []
            : [[row.message_position, row.serialized_bytes] as const],
        ),
  );
  let messageIndex = positions.length - 1;
  let selectedStart = boundedEnd;
  let selectedCount = 0;
  let bytes = 0;
  for (
    let displayPosition = boundedEnd - 1;
    displayPosition >= boundedStart;
    displayPosition -= 1
  ) {
    if (selectedCount >= maxMessages) {
      break;
    }
    const boundary = boundaries.get(displayPosition);
    const messagePosition = boundary ? undefined : positions[messageIndex--];
    const serializedBytes =
      boundary?.serializedBytes ??
      (messagePosition === undefined ? undefined : messageBytes.get(messagePosition));
    if (serializedBytes === undefined) {
      continue;
    }
    if (selectedCount > 0 && bytes + serializedBytes > maxBytes) {
      break;
    }
    selectedStart = displayPosition;
    selectedCount += 1;
    bytes += serializedBytes;
  }
  return selectedStart;
}

function readVisibleMessageById(
  projection: CurrentTranscriptProjection,
  eventId: string,
): SessionTranscriptMessageEvent | undefined {
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
      .where("identity.event_id", "=", eventId)
      .where("active.message_position", "is not", null),
  );
  if (!row || row.message_position === null) {
    return undefined;
  }
  const visible = resolveVisibleMessagePositions(projection);
  const logicalPosition =
    row.message_position >= visible.postStart
      ? visible.kept.length + row.message_position - visible.postStart
      : visible.kept.indexOf(row.message_position);
  return logicalPosition < 0
    ? undefined
    : { event: JSON.parse(row.event_json) as TranscriptEvent, seq: logicalPosition + 1 };
}

function resolveHistoryEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  history = resolveVisibleHistoryProjection(projection),
): SessionTranscriptMessageEvent | undefined {
  const boundary = history.boundaries.find((candidate) => candidate.eventId === eventId);
  if (boundary) {
    const event = readBoundaryEvents(projection, [boundary]).get(boundary.eventSeq);
    return event ? { event, seq: boundary.displayPosition + 1 } : undefined;
  }
  const message = readVisibleMessageById(projection, eventId);
  if (!message) {
    return undefined;
  }
  const messagePosition = message.seq - 1;
  const precedingBoundaries = history.boundaries.filter(
    (candidate) => candidate.messagePosition <= messagePosition,
  ).length;
  return {
    event: message.event,
    seq: message.seq + precedingBoundaries,
  };
}

export function readSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    return readVisibleHistoryRange(projection, 0, history.total, history);
  });
}

export function readRecentSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxLines: number; maxMessages: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
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
        totalMessages: history.total,
      };
    }
    const maxBytes = Math.max(
      1024,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024),
    );
    const selectedStart = resolveRecentHistoryStart(
      projection,
      Math.max(0, history.total - maxLines),
      history.total,
      history,
      maxBytes,
      maxMessages,
    );
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: readVisibleHistoryRange(projection, selectedStart, history.total, history),
      totalMessages: history.total,
    };
  });
}

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; offset: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
      history.total,
    );
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
    );
    const endExclusive = Math.max(0, history.total - offset);
    const start = Math.max(0, endExclusive - maxMessages);
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: readVisibleHistoryRange(projection, start, endExclusive, history),
      totalMessages: history.total,
    };
  });
}

export function readSessionTranscriptHistoryEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => resolveVisibleHistoryProjection(projection).total,
  );
}

export function readSessionTranscriptHistoryEventById(
  scope: SessionTranscriptReadScope,
  eventId: string,
): SessionTranscriptMessageEvent | undefined {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    resolveHistoryEventById(projection, eventId),
  );
}

export function readSessionTranscriptHistoryAnchorPage(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; messageId: string },
): SessionTranscriptMessageAnchorPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const anchor = resolveHistoryEventById(projection, options.messageId, history);
    if (!anchor) {
      return {
        events: [],
        found: false,
        hasOverreadContext: false,
        offset: 0,
        totalMessages: history.total,
      };
    }
    const pageSize = Math.max(
      1,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1),
    );
    const anchorPosition = anchor.seq - 1;
    const newerMessages = Math.floor(pageSize / 2);
    const olderMessages = pageSize - newerMessages - 1;
    const latestStart = Math.max(0, history.total - pageSize);
    const start = Math.min(Math.max(0, anchorPosition - olderMessages), latestStart);
    const endExclusive = Math.min(history.total, start + pageSize);
    const readStart = Math.max(0, start - 1);
    return {
      events: readVisibleHistoryRange(projection, readStart, endExclusive, history),
      found: true,
      hasOverreadContext: readStart < start,
      offset: history.total - endExclusive,
      totalMessages: history.total,
    };
  });
}
