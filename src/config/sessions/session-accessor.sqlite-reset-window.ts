// Reset boundaries project a logical message window without rewriting raw cursor positions.
import type { SessionTreeEntry } from "@openclaw/agent-core";
import { sql } from "kysely";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
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
  eventSeq: number;
  seq: number;
};

type ResetMessageWindow = {
  boundarySeq: number;
  generation: string | undefined;
  indexedSeq: number;
  contextPrefixEventCount: number;
  keptMessagePositions: number[];
  contextPrefixSizeBytes: number;
  postBoundaryMessagePosition: number;
  boundaryActivePosition: number;
};

type ResetMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
  window: ResetMessageWindow | null;
};

// History readers span compactions (their window closes only at a reset). The preflight
// fuse must measure the transcript the model will actually see, which a compaction rewrites
// too; measuring it on the history scope keeps the fuse latched after the first compaction.
type BoundaryWindowScope = "history" | "context";

function isWindowBoundary(eventType: unknown, scope: BoundaryWindowScope): boolean {
  return eventType === "reset" || (scope === "context" && eventType === "compaction");
}

const resetMessageWindowCache = new Map<string, ResetMessageWindowCacheEntry>();
const MAX_RESET_MESSAGE_WINDOW_CACHE = 64;

function getResetWindowKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ResetWindowDatabase>(database.db);
}

function parseMessageEventRow(row: {
  event_seq: number;
  event_json: string;
  message_position: number | null;
}): ResetWindowMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    eventSeq: row.event_seq,
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
      .select(["active.event_seq", "active.message_position", "event.event_json"])
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

export function readTranscriptProjectionGeneration(
  projection: ResetWindowProjection,
): string | undefined {
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

function readLatestActiveBoundaryMetadataByType(
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
      .select(["active.active_position", "identity.event_type", "identity.seq"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "=", eventType)
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
}

function readLatestActiveBoundaryMetadata(
  projection: ResetWindowProjection,
  scope: BoundaryWindowScope,
) {
  const reset = readLatestActiveBoundaryMetadataByType(projection, "reset");
  if (scope === "history") {
    return reset;
  }
  const compaction = readLatestActiveBoundaryMetadataByType(projection, "compaction");
  return reset && (!compaction || reset.seq > compaction.seq) ? reset : compaction;
}

function readBoundaryPayload(
  projection: ResetWindowProjection,
  seq: number,
  scope: BoundaryWindowScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", seq)
      .limit(1),
  );
  if (!row) {
    throw new Error("Active transcript boundary is missing");
  }
  const parsed = JSON.parse(row.event_json) as { firstKeptEntryId?: unknown; type?: unknown };
  if (!isWindowBoundary(parsed.type, scope)) {
    throw new Error("Active transcript boundary has invalid payload");
  }
  return {
    event: parsed,
    sizeBytes: Buffer.byteLength(row.event_json, "utf8") + 1,
  };
}

function findLatestResetMessageWindow(
  projection: ResetWindowProjection,
  generation: string | undefined,
  scope: BoundaryWindowScope,
): ResetMessageWindow | null {
  const db = getResetWindowKysely(projection.database);
  const latestBoundary = readLatestActiveBoundaryMetadata(projection, scope);
  if (!latestBoundary) {
    return null;
  }
  const boundaryPayload = readBoundaryPayload(projection, latestBoundary.seq, scope);
  const boundary = boundaryPayload.event;
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", latestBoundary.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  let keptMessagePositions: number[] = [];
  const includesBoundary = latestBoundary.event_type === "compaction";
  let contextPrefixEventCount = includesBoundary ? 1 : 0;
  let contextPrefixSizeBytes = includesBoundary ? boundaryPayload.sizeBytes : 0;
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
    if (firstKept && firstKept.active_position < latestBoundary.active_position) {
      const candidates = executeSqliteQuerySync(
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
          .where("active.active_position", "<", latestBoundary.active_position)
          .where("active.message_position", "is not", null)
          .$if(scope === "context", (query) => query.where("active.context_eligible", "=", 1))
          .orderBy("active.active_position", "asc"),
      ).rows.flatMap((row) => {
        try {
          return [{ ...row, event: JSON.parse(row.event_json) as SessionTreeEntry }];
        } catch {
          return [];
        }
      });
      const candidateEntries = candidates.map((row) => row.event);
      // A compaction keeps its whole tail; a reset replays only the paired subset.
      const keptEntries = new Set(
        latestBoundary.event_type === "reset"
          ? selectResetKeptEntries(candidateEntries)
          : candidateEntries,
      );
      const keptRows = candidates.filter((row) => keptEntries.has(row.event));
      contextPrefixEventCount += keptRows.length;
      contextPrefixSizeBytes += keptRows.reduce(
        (total, row) => total + Buffer.byteLength(row.event_json, "utf8") + 1,
        0,
      );
      // History presentation exposes user/assistant rows, while fresh-thread context
      // also retains paired tool results. The fuse stats above must cover that context.
      keptMessagePositions = keptRows.flatMap((row) => {
        if (row.message_position === null || row.event.type !== "message") {
          return [];
        }
        const role = row.event.message.role;
        return role === "user" || role === "assistant" ? [row.message_position] : [];
      });
    }
  }
  return {
    boundarySeq: latestBoundary.seq,
    generation,
    indexedSeq: projection.state.indexedSeq,
    contextPrefixEventCount,
    keptMessagePositions,
    contextPrefixSizeBytes,
    postBoundaryMessagePosition,
    boundaryActivePosition: latestBoundary.active_position,
  };
}

function resolveResetMessageWindow(
  projection: ResetWindowProjection,
  scope: BoundaryWindowScope = "history",
): ResetMessageWindow | null {
  const key = `${resetMessageWindowCacheKey(projection)}\0${scope}`;
  const cached = resetMessageWindowCache.get(key);
  const generation = readTranscriptProjectionGeneration(projection);
  if (cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
    if (cached.generation === generation && cached.window) {
      const latestBoundary = readLatestActiveBoundaryMetadata(projection, scope);
      if (latestBoundary?.seq === cached.window.boundarySeq) {
        const window = { ...cached.window, indexedSeq: projection.state.indexedSeq };
        cacheResetMessageWindow(key, { generation, indexedSeq: window.indexedSeq, window });
        return window;
      }
    }
  }
  const window = findLatestResetMessageWindow(projection, generation, scope);
  cacheResetMessageWindow(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  return window;
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

/** Reads logical transcript bytes, reusing cached retained-tail facts after resets. */
export function readVisibleTranscriptStats(projection: ResetWindowProjection): {
  eventCount: number;
  sizeBytes: number;
} {
  const window = resolveResetMessageWindow(projection, "context");
  const db = getResetWindowKysely(projection.database);
  const base = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select((eb) => [
      eb.fn.count<number>("active.event_seq").as("event_count"),
      /* kysely-allow-raw: JSONL size includes one terminating newline per event. */
      sql<number>`COALESCE(SUM(OCTET_LENGTH(event.event_json)), 0)
        + COUNT(*)`.as("size_bytes"),
    ])
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.context_eligible", "=", 1);
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    window ? base.where("active.active_position", ">", window.boundaryActivePosition) : base,
  );
  return {
    eventCount: (row?.event_count ?? 0) + (window?.contextPrefixEventCount ?? 0),
    sizeBytes: (row?.size_bytes ?? 0) + (window?.contextPrefixSizeBytes ?? 0),
  };
}
