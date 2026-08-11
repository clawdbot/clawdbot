// Reset and model-context boundaries project logical message windows without
// rewriting raw cursor positions.
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type ResetWindowDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "transcript_rewrite_watermarks"
  | "transcript_event_identities"
  | "transcript_events"
>;

type ResetWindowProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

type VisibleMessagePositions = {
  kept: number[];
  postStart: number;
  total: number;
};

type ResetWindowMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

type ContextBoundarySummary = {
  text: string;
  ts: number;
};

type ResetMessageWindow = {
  generation: string | undefined;
  indexedSeq: number;
  keptMessagePositions: number[];
  postBoundaryMessagePosition: number;
};

type ResetMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
  window: ResetMessageWindow | null;
};

type SessionTranscriptContextWindow = {
  contextSummary?: ContextBoundarySummary;
  scanStartActivePosition: number;
};

const resetMessageWindowCache = new Map<string, ResetMessageWindowCacheEntry>();
const MAX_MESSAGE_WINDOW_CACHE = 64;
const MAX_CONTEXT_BOUNDARY_BYTES = 1024 * 1024;

function getResetWindowKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ResetWindowDatabase>(database.db);
}

function parseMessageEventRow(row: {
  event_json: string;
  message_position: number | null;
}): ResetWindowMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: row.message_position + 1,
  };
}

function readMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const db = getResetWindowKysely(projection.database);
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

function messageWindowCacheKey(projection: ResetWindowProjection): string {
  return `${projection.database.path}\0${projection.resolved.sessionId}`;
}

function readTranscriptGeneration(projection: ResetWindowProjection): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", projection.resolved.sessionId),
  )?.generation;
}

function sqliteBoundarySerializedBytes() {
  return /* kysely-allow-raw: boundary size is checked before scalar projection. */ sql<number>`LENGTH(CAST(event.event_json AS BLOB))`;
}

function sqliteBoundaryJsonValid() {
  return /* kysely-allow-raw: boundary JSON validity is part of the fail-closed contract. */ sql<number>`json_valid(event.event_json)`;
}

function sqliteBoundaryFirstKeptEntryId() {
  return /* kysely-allow-raw: project one bounded canonical boundary scalar. */ sql<
    string | null
  >`CASE
    WHEN LENGTH(CAST(event.event_json AS BLOB)) <= ${MAX_CONTEXT_BOUNDARY_BYTES}
      AND json_valid(event.event_json)
      AND json_type(event.event_json, '$.firstKeptEntryId') = 'text'
    THEN json_extract(event.event_json, '$.firstKeptEntryId')
    ELSE NULL
  END`;
}

function sqliteBoundarySummary() {
  return /* kysely-allow-raw: project one bounded canonical boundary scalar. */ sql<
    string | null
  >`CASE
    WHEN LENGTH(CAST(event.event_json AS BLOB)) <= ${MAX_CONTEXT_BOUNDARY_BYTES}
      AND json_valid(event.event_json)
      AND json_type(event.event_json, '$.summary') = 'text'
    THEN json_extract(event.event_json, '$.summary')
    ELSE NULL
  END`;
}

function sqliteBoundaryTimestamp() {
  return /* kysely-allow-raw: project one bounded canonical boundary scalar. */ sql<
    string | number | null
  >`CASE
    WHEN LENGTH(CAST(event.event_json AS BLOB)) <= ${MAX_CONTEXT_BOUNDARY_BYTES}
      AND json_valid(event.event_json)
      AND json_type(event.event_json, '$.timestamp') IN ('integer', 'real', 'text')
    THEN json_extract(event.event_json, '$.timestamp')
    ELSE NULL
  END`;
}

function sqliteContextMessageRole() {
  return /* kysely-allow-raw: inspect the canonical role without loading payload JSON. */ sql<
    string | null
  >`CASE WHEN json_valid(event.event_json)
    THEN json_extract(event.event_json, '$.message.role') ELSE NULL END`;
}

function sqliteContextMessageSerializedBytes() {
  return /* kysely-allow-raw: enforce the payload budget before materialization. */ sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`;
}

function readLatestActiveBoundaryByType(
  projection: ResetWindowProjection,
  eventType: "compaction" | "reset",
) {
  const db = getResetWindowKysely(projection.database);
  return executeSqliteQueryTakeFirstSync(
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
        "active.active_position",
        "identity.event_type",
        "identity.seq",
        sqliteBoundarySerializedBytes().as("serialized_bytes"),
        sqliteBoundaryJsonValid().as("json_valid"),
        sqliteBoundaryFirstKeptEntryId().as("first_kept_entry_id"),
        sqliteBoundarySummary().as("summary"),
        sqliteBoundaryTimestamp().as("timestamp"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "=", eventType)
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
}

function readLatestActiveBoundary(projection: ResetWindowProjection) {
  const reset = readLatestActiveBoundaryByType(projection, "reset");
  const compaction = readLatestActiveBoundaryByType(projection, "compaction");
  if (!reset) {
    return compaction;
  }
  if (!compaction) {
    return reset;
  }
  return reset.seq > compaction.seq ? reset : compaction;
}

function assertUsableBoundary(
  boundary: NonNullable<ReturnType<typeof readLatestActiveBoundary>>,
): void {
  if (boundary.serialized_bytes > MAX_CONTEXT_BOUNDARY_BYTES || boundary.json_valid !== 1) {
    throw new Error("Active transcript boundary exceeds the bounded context contract");
  }
}

function readFirstKeptActivePosition(
  projection: ResetWindowProjection,
  firstKeptEntryId: unknown,
  boundaryActivePosition: number,
): number | undefined {
  if (typeof firstKeptEntryId !== "string") {
    return undefined;
  }
  const db = getResetWindowKysely(projection.database);
  const firstKept = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .select("active.active_position")
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", firstKeptEntryId),
  );
  return firstKept && firstKept.active_position < boundaryActivePosition
    ? firstKept.active_position
    : undefined;
}

function findLatestResetMessageWindow(
  projection: ResetWindowProjection,
  generation: string | undefined,
): ResetMessageWindow | null {
  const db = getResetWindowKysely(projection.database);
  const latestBoundaryRow = readLatestActiveBoundary(projection);
  if (!latestBoundaryRow || latestBoundaryRow.event_type !== "reset") {
    return null;
  }
  assertUsableBoundary(latestBoundaryRow);
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", latestBoundaryRow.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  let keptMessagePositions: number[] = [];
  const firstKeptActivePosition = readFirstKeptActivePosition(
    projection,
    latestBoundaryRow.first_kept_entry_id,
    latestBoundaryRow.active_position,
  );
  if (firstKeptActivePosition !== undefined) {
    keptMessagePositions = executeSqliteQuerySync(
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
        .where("active.active_position", ">=", firstKeptActivePosition)
        .where("active.active_position", "<", latestBoundaryRow.active_position)
        .where("active.message_position", "is not", null)
        .orderBy("active.active_position", "asc"),
    ).rows.flatMap((row) => {
      if (row.message_position === null) {
        return [];
      }
      try {
        const role = (JSON.parse(row.event_json) as { message?: { role?: unknown } }).message?.role;
        return role === "user" || role === "assistant" ? [row.message_position] : [];
      } catch {
        return [];
      }
    });
  }
  return {
    generation,
    indexedSeq: projection.state.indexedSeq,
    keptMessagePositions,
    postBoundaryMessagePosition,
  };
}

function findContextMessageWindow(
  projection: ResetWindowProjection,
): SessionTranscriptContextWindow | null {
  const latestBoundaryRow = readLatestActiveBoundary(projection);
  if (!latestBoundaryRow) {
    return null;
  }
  assertUsableBoundary(latestBoundaryRow);
  const retainedStartActivePosition = readFirstKeptActivePosition(
    projection,
    latestBoundaryRow.first_kept_entry_id,
    latestBoundaryRow.active_position,
  );
  return {
    scanStartActivePosition: retainedStartActivePosition ?? latestBoundaryRow.active_position + 1,
    ...(latestBoundaryRow.event_type === "compaction" && latestBoundaryRow.summary
      ? {
          contextSummary: {
            text: latestBoundaryRow.summary,
            ts:
              typeof latestBoundaryRow.timestamp === "string"
                ? Date.parse(latestBoundaryRow.timestamp) || 0
                : typeof latestBoundaryRow.timestamp === "number" &&
                    Number.isFinite(latestBoundaryRow.timestamp)
                  ? latestBoundaryRow.timestamp
                  : 0,
          },
        }
      : {}),
  };
}

function resolveResetMessageWindow(projection: ResetWindowProjection): ResetMessageWindow | null {
  const key = messageWindowCacheKey(projection);
  const cached = resetMessageWindowCache.get(key);
  const generation = readTranscriptGeneration(projection);
  if (cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
  }
  const window = findLatestResetMessageWindow(projection, generation);
  resetMessageWindowCache.delete(key);
  resetMessageWindowCache.set(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  pruneMapToMaxSize(resetMessageWindowCache, MAX_MESSAGE_WINDOW_CACHE);
  return window;
}

function resolveContextMessageWindow(
  projection: ResetWindowProjection,
): SessionTranscriptContextWindow | null {
  return findContextMessageWindow(projection);
}

export function resolveVisibleMessagePositions(
  projection: ResetWindowProjection,
): VisibleMessagePositions {
  const window = resolveResetMessageWindow(projection);
  if (!window) {
    return { kept: [], postStart: 0, total: projection.state.activeMessageCount };
  }
  return {
    kept: window.keptMessagePositions,
    postStart: window.postBoundaryMessagePosition,
    total:
      window.keptMessagePositions.length +
      Math.max(0, projection.state.activeMessageCount - window.postBoundaryMessagePosition),
  };
}

export function readVisibleMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  if (boundedEnd <= boundedStart) {
    return [];
  }
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const keptEvents = visible.kept
    .slice(boundedStart, keptEnd)
    .flatMap((position) => readMessageRange(projection, position, position + 1));
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  const postEvents = readMessageRange(
    projection,
    visible.postStart + postVisibleStart - visible.kept.length,
    visible.postStart + postVisibleEnd - visible.kept.length,
  );
  return [...keptEvents, ...postEvents];
}

/** Maps a logical transcript-visible range to materialized message positions. */
export function resolveVisibleMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): number[] {
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const positions = visible.kept.slice(boundedStart, keptEnd);
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  for (let logical = postVisibleStart; logical < postVisibleEnd; logical += 1) {
    positions.push(visible.postStart + logical - visible.kept.length);
  }
  return positions;
}

/** Reads one authoritative bounded model-context tail from the active semantic window. */
export function readBoundedContextMessageTail(
  projection: ResetWindowProjection,
  options: { maxBytes: number; maxMessages: number; maxScannedMessages: number },
) {
  const maxMessages = Math.max(0, Math.floor(options.maxMessages));
  const maxScannedMessages = Math.max(0, Math.floor(options.maxScannedMessages));
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const contextWindow = resolveContextMessageWindow(projection);
  const db = getResetWindowKysely(projection.database);
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
        sqliteContextMessageRole().as("message_role"),
        sqliteContextMessageSerializedBytes().as("serialized_bytes"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is not", null)
      .$if(contextWindow !== null, (query) =>
        query.where("active.active_position", ">=", contextWindow?.scanStartActivePosition ?? 0),
      )
      .orderBy("active.active_position", "desc")
      .limit(maxScannedMessages + 1),
  ).rows;
  const selectedPositions: number[] = [];
  let serializedBytes = 0;
  let blockedByBytes = false;
  for (const row of metadata.slice(0, maxScannedMessages)) {
    if (
      row.message_position === null ||
      (row.message_role !== "assistant" && row.message_role !== "user")
    ) {
      continue;
    }
    if (selectedPositions.length >= maxMessages) {
      break;
    }
    if (serializedBytes + row.serialized_bytes > maxBytes) {
      blockedByBytes = true;
      break;
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
            .select(["active.message_position", "event.event_json"])
            .where("active.session_id", "=", projection.resolved.sessionId)
            .where("active.message_position", "in", selectedPositions)
            .orderBy("active.message_position", "asc"),
        ).rows.map(parseMessageEventRow);
  return {
    authoritative:
      !blockedByBytes &&
      (selectedPositions.length >= maxMessages || metadata.length <= maxScannedMessages),
    ...(contextWindow?.contextSummary ? { contextSummary: contextWindow.contextSummary } : {}),
    empty: metadata.length === 0 && !contextWindow?.contextSummary,
    events,
  };
}
