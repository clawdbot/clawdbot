// Reset boundaries project a logical message window without rewriting raw cursor positions.
import type { SessionTreeEntry } from "@openclaw/agent-core";
import { sql } from "kysely";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { projectModelContextNavigationSql } from "./session-model-context-projection.js";
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

function selectMessageRows(projection: ResetWindowProjection) {
  return getResetWindowKysely(projection.database)
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.message_position", "is not", null)
    .orderBy("active.message_position", "asc");
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

function readBoundaryWindowFacts(
  projection: ResetWindowProjection,
  seq: number,
  scope: BoundaryWindowScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_events")
      .select((eb) => [
        projectModelContextNavigationSql(eb.ref("event_json")).as("event_json"),
        /* kysely-allow-raw: window accounting needs original bytes, not summary or reset payloads. */
        sql<number>`OCTET_LENGTH(event_json) + 1`.as("serialized_bytes"),
      ])
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
  return { firstKeptEntryId: parsed.firstKeptEntryId, sizeBytes: row.serialized_bytes };
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
  const boundary = readBoundaryWindowFacts(projection, latestBoundary.seq, scope);
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
  let contextPrefixSizeBytes = includesBoundary ? boundary.sizeBytes : 0;
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
      const candidateRows = iterateSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select((eb) => [
            "active.message_position",
            projectModelContextNavigationSql(eb.ref("event.event_json")).as("event_json"),
            /* kysely-allow-raw: raw-byte accounting stays independent of the transient projection. */
            sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
          ])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", latestBoundary.active_position)
          .where("active.message_position", "is not", null)
          .$if(scope === "context", (query) => query.where("active.context_eligible", "=", 1))
          .orderBy("active.active_position", "asc"),
      );
      const candidates = Array.from(candidateRows, (row) => {
        try {
          return [
            {
              message_position: row.message_position,
              serialized_bytes: row.serialized_bytes,
              event: JSON.parse(row.event_json) as SessionTreeEntry,
            },
          ];
        } catch {
          return [];
        }
      }).flat();
      const candidateEntries = candidates.map((row) => row.event);
      // A compaction keeps its whole tail; a reset replays only the paired subset.
      const keptEntries = new Set(
        latestBoundary.event_type === "reset"
          ? selectResetKeptEntries(candidateEntries)
          : candidateEntries,
      );
      const keptRows = candidates.filter((row) => keptEntries.has(row.event));
      contextPrefixEventCount += keptRows.length;
      contextPrefixSizeBytes += keptRows.reduce((total, row) => total + row.serialized_bytes, 0);
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

function selectVisibleMessageRanges(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
) {
  const ranges: Array<{
    query: ReturnType<typeof selectMessageRows>;
    logicalPosition: (position: number) => number;
  }> = [];
  if (endExclusive <= start) {
    return ranges;
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  const query = selectMessageRows(projection);
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  // Reset tails have holes where tool results were discarded. Batch exact retained
  // positions below SQLite's binding limit; sparse tails must not become N+1 reads.
  for (let offset = boundedStart; offset < keptEnd; offset += 500) {
    const positions = visible.kept.slice(offset, Math.min(offset + 500, keptEnd));
    const ordinals = new Map(positions.map((position, index) => [position, offset + index]));
    ranges.push({
      query: query.where("active.message_position", "in", positions),
      logicalPosition: (position) => ordinals.get(position)!,
    });
  }
  const logicalStart = Math.max(boundedStart, visible.kept.length);
  if (boundedEnd > logicalStart) {
    const rawStart = visible.postStart + logicalStart - visible.kept.length;
    ranges.push({
      query: query
        .where("active.message_position", ">=", rawStart)
        .where("active.message_position", "<", rawStart + boundedEnd - logicalStart),
      logicalPosition: (position) => logicalStart + position - rawStart,
    });
  }
  return ranges;
}

export function readVisibleMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  return Array.from(iterateVisibleMessageRange(projection, start, endExclusive));
}

export function* iterateVisibleMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): IterableIterator<ResetWindowMessageEvent> {
  for (const range of selectVisibleMessageRanges(projection, start, endExclusive)) {
    for (const row of iterateSqliteQuerySync(
      projection.database.db,
      range.query.select(["active.event_seq", "active.message_position", "event.event_json"]),
    )) {
      yield parseMessageEventRow(row);
    }
  }
}

/** Sizes the same logical ranges without fetching or parsing excluded payloads. */
export function readVisibleMessageMetadata(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
) {
  return selectVisibleMessageRanges(projection, start, endExclusive).flatMap((range) =>
    executeSqliteQuerySync(
      projection.database.db,
      range.query
        .select([
          "active.message_position",
          /* kysely-allow-raw: byte caps include each event's JSONL newline. */
          sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
        ])
        .$narrowType<{ message_position: number }>(),
    ).rows.map((row) => ({
      message_position: row.message_position,
      serialized_bytes: row.serialized_bytes,
      // Position-based mapping preserves logical holes if a joined row is absent.
      logicalPosition: range.logicalPosition(row.message_position),
    })),
  );
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
