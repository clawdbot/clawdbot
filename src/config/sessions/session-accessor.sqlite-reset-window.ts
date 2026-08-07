// Reset boundaries project a logical message window without rewriting raw cursor positions.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-active-projection.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";

type ResetWindowDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "transcript_rewrite_watermarks"
  | "transcript_event_identities"
  | "transcript_events"
>;

type ResetWindowProjection = CurrentTranscriptProjection;

type VisibleMessagePositions = {
  kept: number[];
  postStart: number;
  total: number;
};

type ResetWindowMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

type ActiveBoundaryEventType = "compaction" | "reset";

type ActiveBoundaryRow = {
  active_position: number;
  event_type: string | null;
  seq: number;
};

type ResetMessageWindow = {
  generation: string | undefined;
  indexedSeq: number;
  keptMessagePositions: number[];
  postBoundaryMessagePosition: number;
};

export type SessionTranscriptGuardState = { hasTranscriptEvents: boolean } & (
  | {
      kind: "empty";
      expectedEntryOnGuardPath: false;
      guardLeafEntryId: null;
    }
  | {
      kind: "identified";
      expectedEntryOnGuardPath: boolean;
      guardLeafEntryId: string;
    }
  | {
      kind: "unavailable";
      expectedEntryOnGuardPath: false;
      guardLeafEntryId: null;
    }
);

type ResetMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
  window: ResetMessageWindow | null;
};

const resetMessageWindowCache = new Map<string, ResetMessageWindowCacheEntry>();
const MAX_RESET_MESSAGE_WINDOW_CACHE = 64;

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

function resetMessageWindowCacheKey(projection: ResetWindowProjection): string {
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

function cacheResetMessageWindow(key: string, entry: ResetMessageWindowCacheEntry): void {
  resetMessageWindowCache.delete(key);
  resetMessageWindowCache.set(key, entry);
  pruneMapToMaxSize(resetMessageWindowCache, MAX_RESET_MESSAGE_WINDOW_CACHE);
}

function findLatestActiveBoundary(
  projection: ResetWindowProjection,
  eventType: ActiveBoundaryEventType,
): ActiveBoundaryRow | undefined {
  const db = getResetWindowKysely(projection.database);
  // Active ancestry preserves append sequence, so the identity index finds one
  // boundary candidate before the active join verifies selected-path membership.
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .select(["active.active_position", "identity.event_type", "identity.seq"])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "=", eventType)
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
}

function findLatestResetMessageWindow(
  projection: ResetWindowProjection,
  generation: string | undefined,
): ResetMessageWindow | null {
  const db = getResetWindowKysely(projection.database);
  const latestReset = findLatestActiveBoundary(projection, "reset");
  const latestCompaction = findLatestActiveBoundary(projection, "compaction");
  const latestBoundaryRow =
    latestReset && (!latestCompaction || latestReset.seq > latestCompaction.seq)
      ? latestReset
      : latestCompaction;
  if (!latestBoundaryRow) {
    return null;
  }
  if (latestBoundaryRow.event_type !== "reset") {
    return null;
  }
  const boundaryEvent = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", latestBoundaryRow.seq),
  );
  if (!boundaryEvent) {
    throw new Error("Active reset boundary is missing its transcript event");
  }
  const boundary = JSON.parse(boundaryEvent.event_json) as {
    firstKeptEntryId?: unknown;
  };
  const resetRow = latestBoundaryRow;
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", resetRow.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  let keptMessagePositions: number[] = [];
  if (typeof boundary.firstKeptEntryId === "string") {
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
        .where("identity.event_id", "=", boundary.firstKeptEntryId),
    );
    if (firstKept && firstKept.active_position < resetRow.active_position) {
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
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", resetRow.active_position)
          .where("active.message_position", "is not", null)
          .orderBy("active.active_position", "asc"),
      ).rows.flatMap((row) => {
        if (row.message_position === null) {
          return [];
        }
        try {
          const role = (JSON.parse(row.event_json) as { message?: { role?: unknown } }).message
            ?.role;
          return role === "user" || role === "assistant" ? [row.message_position] : [];
        } catch {
          return [];
        }
      });
    }
  }
  return {
    generation,
    indexedSeq: projection.state.indexedSeq,
    keptMessagePositions,
    postBoundaryMessagePosition,
  };
}

function resolveResetMessageWindow(projection: ResetWindowProjection): ResetMessageWindow | null {
  const key = resetMessageWindowCacheKey(projection);
  const cached = resetMessageWindowCache.get(key);
  const generation = readTranscriptGeneration(projection);
  if (cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
  }
  const window = findLatestResetMessageWindow(projection, generation);
  cacheResetMessageWindow(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  return window;
}

function resolveVisibleMessagePositionsFromWindow(
  projection: ResetWindowProjection,
  window: ResetMessageWindow | null,
): VisibleMessagePositions {
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

export function resolveVisibleMessagePositions(
  projection: ResetWindowProjection,
): VisibleMessagePositions {
  return resolveVisibleMessagePositionsFromWindow(
    projection,
    resolveResetMessageWindow(projection),
  );
}

/** Resolves the public history/send guard from the logical selected active-event leaf. */
export function resolveSessionTranscriptGuardState(
  projection: ResetWindowProjection,
  expectedEntryId?: string,
): SessionTranscriptGuardState {
  const db = getResetWindowKysely(projection.database);
  const guardRow = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .leftJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select("identity.event_id")
      .where("active.session_id", "=", projection.resolved.sessionId)
      .orderBy("active.active_position", "desc")
      .limit(1),
  );
  if (!guardRow) {
    return {
      kind: "empty",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents: projection.hasTranscriptEvents,
    };
  }
  // The selected leaf is the final logical active row. Keep an identity gap
  // distinct from an empty branch so callers fail closed instead of accepting null.
  if (guardRow.event_id === null) {
    return {
      kind: "unavailable",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents: projection.hasTranscriptEvents,
    };
  }
  const guardLeafEntryId = guardRow.event_id;
  if (!expectedEntryId) {
    return {
      kind: "identified",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId,
      hasTranscriptEvents: projection.hasTranscriptEvents,
    };
  }
  const active = executeSqliteQueryTakeFirstSync(
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
      .where("identity.event_id", "=", expectedEntryId)
      .limit(1),
  );
  const latestReset = findLatestActiveBoundary(projection, "reset");
  return {
    kind: "identified",
    expectedEntryOnGuardPath:
      active !== undefined &&
      (latestReset === undefined || active.active_position >= latestReset.active_position),
    guardLeafEntryId,
    hasTranscriptEvents: projection.hasTranscriptEvents,
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

/** Maps a logical visible-message range to its materialized message positions. */
export function resolveVisibleMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): number[] {
  if (endExclusive <= start) {
    return [];
  }
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
