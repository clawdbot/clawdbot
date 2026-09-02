import { sql } from "kysely";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type {
  SessionTranscriptMessageAnchorPage,
  SessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  getActiveTranscriptKysely,
  readTranscriptProjectionGeneration,
  withCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  createTranscriptRawDeltaCursor,
  readTranscriptRawDelta,
} from "./session-accessor.sqlite-delta.js";
import {
  positionTranscriptDisplayEvents,
  readTranscriptDisplaySource,
} from "./session-accessor.sqlite-display-position.js";
import {
  readVisibleMessageMetadata,
  readVisibleMessageRange,
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
  displaySource?: string;
  total: number;
};

function resolveVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
): VisibleHistoryProjection {
  const displaySource = readTranscriptDisplaySource(projection);
  if (projection.state.activeEventCount === projection.state.activeMessageCount) {
    return { boundaries: [], displaySource, total: projection.state.activeMessageCount };
  }
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
        sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
      ])
      .select((eb) =>
        eb
          .selectFrom("session_transcript_active_events as next")
          .select("next.message_position")
          .whereRef("next.session_id", "=", "active.session_id")
          .whereRef("next.active_position", ">", "active.active_position")
          .where("next.message_position", "is not", null)
          .orderBy("next.active_position", "asc")
          .limit(1)
          .as("next_message_position"),
      )
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "in", ["compaction", "reset"])
      .orderBy("active.active_position", "asc"),
  ).rows;
  const resetIndex = rows.findLastIndex((row) => row.event_type === "reset");
  const visibleRows = rows.slice(Math.max(0, resetIndex));
  const boundaries = visibleRows.map((row, index): VisibleHistoryBoundary => {
    // Kept messages precede the latest reset; later markers share its logical window.
    // Rebase raw positions so discarded messages cannot shift those markers.
    const nextMessagePosition = row.next_message_position ?? projection.state.activeMessageCount;
    const messagePosition =
      visibleMessages.kept.length + Math.max(0, nextMessagePosition - visibleMessages.postStart);
    return {
      displayPosition: messagePosition + index,
      eventId: row.event_id,
      eventSeq: row.seq,
      messagePosition,
      serializedBytes: row.serialized_bytes,
    };
  });
  return {
    boundaries,
    displaySource,
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
        events.push({ event, eventSeq: boundary.eventSeq, seq: displayPosition + 1 });
      }
      continue;
    }
    const message = messages[messageIndex++];
    if (message) {
      events.push({ ...message, seq: displayPosition + 1 });
    }
  }
  return positionTranscriptDisplayEvents(projection, history.displaySource, events);
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
  // only add synchronous work before the backward scan stops.
  const metadataStart = Math.max(messageStart, messageEnd - maxMessages);
  const messageBytes = new Map(
    readVisibleMessageMetadata(projection, metadataStart, messageEnd).map((row) => [
      row.logicalPosition,
      row.serialized_bytes,
    ]),
  );
  let messageIndex = messageEnd - 1;
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
    const logicalPosition = boundary ? undefined : messageIndex--;
    const serializedBytes =
      boundary?.serializedBytes ??
      (logicalPosition === undefined ? undefined : messageBytes.get(logicalPosition));
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
  history: VisibleHistoryProjection,
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
      .select(["active.event_seq", "active.message_position", "event.event_json"])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", eventId)
      .where("active.message_position", "is not", null),
  );
  if (!row || row.message_position === null) {
    return undefined;
  }
  const seq = resolveHistoryMessageSequence(
    resolveVisibleMessagePositions(projection),
    history,
    row.message_position,
  );
  return seq === undefined
    ? undefined
    : {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        eventSeq: row.event_seq,
        seq,
      };
}

function resolveHistoryMessageSequence(
  visible: ReturnType<typeof resolveVisibleMessagePositions>,
  history: VisibleHistoryProjection,
  messagePosition: number,
): number | undefined {
  const logicalPosition =
    messagePosition >= visible.postStart
      ? visible.kept.length + messagePosition - visible.postStart
      : visible.kept.indexOf(messagePosition);
  if (logicalPosition < 0) {
    return undefined;
  }
  const precedingBoundaries = history.boundaries.filter(
    (candidate) => candidate.messagePosition <= logicalPosition,
  ).length;
  return logicalPosition + 1 + precedingBoundaries;
}

function resolveHistoryEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  history = resolveVisibleHistoryProjection(projection),
): SessionTranscriptMessageEvent | undefined {
  const boundary = history.boundaries.find((candidate) => candidate.eventId === eventId);
  if (boundary) {
    const event = readBoundaryEvents(projection, [boundary]).get(boundary.eventSeq);
    return event
      ? { event, eventSeq: boundary.eventSeq, seq: boundary.displayPosition + 1 }
      : undefined;
  }
  return readVisibleMessageById(projection, eventId, history);
}

type SessionTranscriptRawDeltaPage = Extract<SessionTranscriptRawDeltaResult, { kind: "page" }>;

export type SessionTranscriptDisplayDeltaResult =
  | (Omit<SessionTranscriptRawDeltaPage, "events"> & {
      activeLeafEntryId: string | null;
      events: Array<
        SessionTranscriptRawDeltaPage["events"][number] & {
          messageSeq?: number;
          displayPosition?: TranscriptDisplayPosition;
        }
      >;
    })
  | Exclude<SessionTranscriptRawDeltaResult, { kind: "page" }>;

/** Raw cursor progress carries the same reset-relative ordinals as pages and live messages. */
export function readTranscriptDisplayDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptDisplayDeltaResult {
  const readLimits = { ...limits };
  return withCurrentProjectionSnapshot(scope, (projection) => {
    // The nested raw read shares this deferred transaction; cursor progress and
    // display placement must describe the same active branch and generation.
    const result = readTranscriptRawDelta(scope, readLimits);
    if (result.kind !== "page") {
      return result;
    }
    const history = resolveVisibleHistoryProjection(projection);
    const visible = resolveVisibleMessagePositions(projection);
    const firstSeq = result.events[0]?.seq;
    const lastSeq = result.events.at(-1)?.seq;
    const db = getActiveTranscriptKysely(projection.database);
    const sequences = new Map(
      firstSeq === undefined || lastSeq === undefined
        ? []
        : executeSqliteQuerySync(
            projection.database.db,
            db
              .selectFrom("session_transcript_active_events")
              .select(["event_seq", "message_position"])
              .where("session_id", "=", projection.resolved.sessionId)
              .where("event_seq", ">=", firstSeq)
              .where("event_seq", "<=", lastSeq)
              .where("message_position", "is not", null),
          ).rows.map((row) => [
            row.event_seq,
            row.message_position === null
              ? undefined
              : resolveHistoryMessageSequence(visible, history, row.message_position),
          ]),
    );
    const events = positionTranscriptDisplayEvents(
      projection,
      history.displaySource,
      result.events.map((row) => {
        const messageSeq = sequences.get(row.seq);
        return { ...row, eventSeq: row.seq, ...(messageSeq === undefined ? {} : { messageSeq }) };
      }),
    );
    return { ...result, activeLeafEntryId: projection.state.leafEventId, events };
  });
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
    const generation = readTranscriptProjectionGeneration(projection);
    const deltaCursor = generation
      ? createTranscriptRawDeltaCursor({
          agentId: projection.resolved.agentId,
          generation,
          lastSeq: projection.state.indexedSeq,
          sessionId: projection.resolved.sessionId,
        })
      : undefined;
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
        ...(deltaCursor ? { deltaCursor } : {}),
        events: [],
        displaySource: history.displaySource,
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
      ...(deltaCursor ? { deltaCursor } : {}),
      events: readVisibleHistoryRange(projection, selectedStart, history.total, history),
      displaySource: history.displaySource,
      totalMessages: history.total,
    };
  });
}

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; offset: number; readOnly?: boolean },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
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
        displaySource: history.displaySource,
        totalMessages: history.total,
      };
    },
    options,
  );
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
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const event = resolveHistoryEventById(projection, eventId, history);
    return event
      ? positionTranscriptDisplayEvents(projection, history.displaySource, [event])[0]
      : undefined;
  });
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
        displaySource: history.displaySource,
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
      displaySource: history.displaySource,
      totalMessages: history.total,
    };
  });
}
