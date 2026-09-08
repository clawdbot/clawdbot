import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { SessionTranscriptMessageAnchorPage } from "./session-accessor.sqlite-active-events.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-active-projection.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { positionTranscriptDisplayEvents } from "./session-accessor.sqlite-display-position.js";
import {
  resolveClosedResetInterval,
  type ClosedResetInterval,
} from "./session-accessor.sqlite-reset-window.js";

const HISTORY_DISPLAY_EVENT_TYPES = ["compaction", "reset"] as const;

export function parseStoredTranscriptEvent(eventJson: string): TranscriptEvent {
  // SAFETY: The active projection indexes serialized TranscriptEvent rows.
  return JSON.parse(eventJson) as TranscriptEvent;
}

function selectHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
) {
  return getActiveTranscriptKysely(projection.database)
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
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.active_position", ">", interval.startExclusiveActivePosition)
    .where("active.active_position", "<=", interval.endInclusiveActivePosition)
    .where((eb) =>
      eb.or([
        eb("active.message_position", "is not", null),
        eb("identity.event_type", "in", HISTORY_DISPLAY_EVENT_TYPES),
      ]),
    );
}

function readDisplayableActiveEventById(projection: CurrentTranscriptProjection, eventId: string) {
  const db = getActiveTranscriptKysely(projection.database);
  return executeSqliteQueryTakeFirstSync(
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
      .select([
        "active.event_seq",
        "active.active_position",
        "active.message_position",
        "identity.event_type",
        "event.event_json",
      ])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", eventId)
      .where((eb) =>
        eb.or([
          eb("active.message_position", "is not", null),
          eb("identity.event_type", "in", HISTORY_DISPLAY_EVENT_TYPES),
        ]),
      ),
  );
}

function countHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
  beforeActivePosition?: number,
): number {
  let query = selectHistoricalDisplayEvents(projection, interval).select((eb) =>
    eb.fn.countAll<number>().as("event_count"),
  );
  if (beforeActivePosition !== undefined) {
    query = query.where("active.active_position", "<", beforeActivePosition);
  }
  const row = executeSqliteQueryTakeFirstSync(projection.database.db, query);
  return row?.event_count ?? 0;
}

function readHistoricalDisplayEventRange(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  interval: ClosedResetInterval,
  start: number,
  count: number,
): SessionTranscriptMessageEvent[] {
  if (count <= 0) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    projection.database.db,
    selectHistoricalDisplayEvents(projection, interval)
      .select(["active.event_seq", "event.event_json"])
      .orderBy("active.active_position", "asc")
      .offset(start)
      .limit(count),
  ).rows;
  return positionTranscriptDisplayEvents(
    projection,
    displaySource,
    rows.map((row, index) => ({
      event: parseStoredTranscriptEvent(row.event_json),
      eventSeq: row.event_seq,
      seq: start + index + 1,
    })),
  );
}

function resolveClosedResetIntervalForDisplayable(
  projection: CurrentTranscriptProjection,
  row: { active_position: number; event_type: string | null },
): ClosedResetInterval | undefined {
  if (typeof row.event_type !== "string") {
    return undefined;
  }
  return resolveClosedResetInterval(projection, {
    activePosition: row.active_position,
    eventType: row.event_type,
  });
}

export function resolveHistoricalHistoryEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
): SessionTranscriptMessageEvent | undefined {
  const row = readDisplayableActiveEventById(projection, eventId);
  if (!row) {
    return undefined;
  }
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  return {
    event: parseStoredTranscriptEvent(row.event_json),
    eventSeq: row.event_seq,
    seq: countHistoricalDisplayEvents(projection, interval, row.active_position) + 1,
  };
}

export function readHistoricalHistoryAnchorPage(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  options: { maxMessages: number; messageId: string },
): SessionTranscriptMessageAnchorPage | undefined {
  const row = readDisplayableActiveEventById(projection, options.messageId);
  if (!row) {
    return undefined;
  }
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  const total = countHistoricalDisplayEvents(projection, interval);
  const anchorPosition = countHistoricalDisplayEvents(projection, interval, row.active_position);
  const pageSize = Math.max(
    1,
    Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1),
  );
  const newerMessages = Math.floor(pageSize / 2);
  const olderMessages = pageSize - newerMessages - 1;
  const latestStart = Math.max(0, total - pageSize);
  const start = Math.min(Math.max(0, anchorPosition - olderMessages), latestStart);
  const endExclusive = Math.min(total, start + pageSize);
  const readStart = Math.max(0, start - 1);
  return {
    events: readHistoricalDisplayEventRange(
      projection,
      displaySource,
      interval,
      readStart,
      endExclusive - readStart,
    ),
    found: true,
    hasOverreadContext: readStart < start,
    offset: total - endExclusive,
    displaySource,
    totalMessages: total,
  };
}
