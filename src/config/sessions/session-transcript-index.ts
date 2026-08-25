// Active transcript projection maintenance shared by the SQLite session
// accessor, bounded history readers, and full-text search. Both projections
// mirror the ACTIVE transcript branch only. Invariant: the
// watermark's leaf_event_id always equals the append parent the accessor
// would resolve next; an append that chains onto it forward-indexes in the
// same transaction, anything ambiguous (leaf controls, branch switches)
// marks the session dirty for its write or maintenance owner to rebuild from
// the canonical visible-path resolver.
import type { DatabaseSync } from "node:sqlite";
import type { ColumnType } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  buildSessionTranscriptProjection,
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  type SessionTranscriptProjectionSourceRow,
  type TranscriptIndexEntry,
} from "./session-transcript-projection-rebuild.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  isSessionTranscriptSideAppendEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
type TranscriptIndexDatabase = Omit<
  Pick<
    OpenClawAgentKyselyDatabase,
    | "session_windows"
    | "session_transcript_active_events"
    | "session_transcript_fts"
    | "session_transcript_index_state"
    | "transcript_events"
  >,
  "session_transcript_fts"
> & {
  session_transcript_fts: Omit<
    OpenClawAgentKyselyDatabase["session_transcript_fts"],
    "timestamp"
  > & {
    timestamp: ColumnType<string | null, number | string | null, number | string | null>;
  };
};

export type SessionTranscriptProjectionState = {
  activeEventCount: number;
  activeMessageCount: number;
  indexedSeq: number;
  leafEventId: string | null;
  needsRebuild: boolean;
};

// FTS rebuilds cost about 60 ms per 1,000 events/1 MiB on dev hardware; cap synchronous
// work near a 250 ms event-loop stall and leave larger projections to the reconcile worker.
export const SYNC_REBUILD_MAX_ROWS = 4_000;
export const SYNC_REBUILD_MAX_BYTES = 4 * 1024 * 1024;

function getIndexKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptIndexDatabase>(db);
}

/** Size the old projection and incoming rows before their owning transaction mutates either. */
export function shouldRebuildSessionTranscriptIndexSynchronously(
  db: DatabaseSync,
  sessionId: string,
  events: readonly unknown[] = [],
): boolean {
  if (events.length > SYNC_REBUILD_MAX_ROWS) {
    return false;
  }
  const stored = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.countAll<number>().as("event_count"),
        eb.fn.sum<number>(eb.fn<number>("length", ["event_json"])).as("event_bytes"),
      ])
      .where("session_id", "=", sessionId),
  );
  if ((stored?.event_count ?? 0) + events.length > SYNC_REBUILD_MAX_ROWS) {
    return false;
  }
  let bytes = stored?.event_bytes ?? 0;
  if (bytes > SYNC_REBUILD_MAX_BYTES) {
    return false;
  }
  for (const event of events) {
    bytes += JSON.stringify(event).length;
    if (bytes > SYNC_REBUILD_MAX_BYTES) {
      return false;
    }
  }
  return true;
}

function readSessionTranscriptProjectionState(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptProjectionState | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("session_transcript_index_state")
      .select([
        "active_event_count",
        "active_message_count",
        "indexed_seq",
        "leaf_event_id",
        "needs_rebuild",
      ])
      .where("session_id", "=", sessionId),
  );
  if (!row) {
    return undefined;
  }
  return {
    activeEventCount: row.active_event_count,
    activeMessageCount: row.active_message_count,
    indexedSeq: row.indexed_seq,
    leafEventId: row.leaf_event_id,
    needsRebuild: row.needs_rebuild !== 0,
  };
}

export function sessionTranscriptIndexNeedsReconcile(db: DatabaseSync, sessionId: string): boolean {
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!latest) {
    return false;
  }
  const state = readSessionTranscriptProjectionState(db, sessionId);
  return !state || state.needsRebuild || state.indexedSeq !== latest.seq;
}

function writeWatermark(
  db: DatabaseSync,
  sessionId: string,
  watermark: SessionTranscriptProjectionState,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .insertInto("session_transcript_index_state")
      .values({
        session_id: sessionId,
        active_event_count: watermark.activeEventCount,
        active_message_count: watermark.activeMessageCount,
        indexed_seq: watermark.indexedSeq,
        leaf_event_id: watermark.leafEventId,
        needs_rebuild: watermark.needsRebuild ? 1 : 0,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          active_event_count: watermark.activeEventCount,
          active_message_count: watermark.activeMessageCount,
          indexed_seq: watermark.indexedSeq,
          leaf_event_id: watermark.leafEventId,
          needs_rebuild: watermark.needsRebuild ? 1 : 0,
          updated_at: now,
        }),
      ),
  );
}

function insertActiveEventRow(
  db: DatabaseSync,
  params: {
    activePosition: number;
    eventSeq: number;
    messagePosition: number | null;
    sessionId: string;
  },
): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).insertInto("session_transcript_active_events").values({
      session_id: params.sessionId,
      active_position: params.activePosition,
      event_seq: params.eventSeq,
      message_position: params.messagePosition,
    }),
  );
}

function deleteActiveEventRows(db: DatabaseSync, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .deleteFrom("session_transcript_active_events")
      .where("session_id", "=", sessionId),
  );
}

function insertFtsRow(db: DatabaseSync, sessionId: string, entry: TranscriptIndexEntry): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).insertInto("session_transcript_fts").values({
      text: entry.text,
      session_id: sessionId,
      message_id: entry.messageId,
      role: entry.role,
      // FTS5 aux columns are typeless; the local insert type preserves the
      // numeric timestamp SQLite stores while generated readers stay strings.
      timestamp: entry.timestamp,
    }),
  );
}

function deleteFtsRows(db: DatabaseSync, sessionId: string): void {
  // session_id is UNINDEXED in FTS5, so this scans the index; transcript
  // deletion and rebuilds are rare lifecycle events.
  executeSqliteQuerySync(
    db,
    getIndexKysely(db).deleteFrom("session_transcript_fts").where("session_id", "=", sessionId),
  );
}

/**
 * In-transaction append hook. Forward-indexes the event when it
 * unambiguously extends the active branch and marks the session for rebuild
 * otherwise. Runs inside the same write transaction as the event insert, so
 * the index can never lag or tear relative to committed transcript rows.
 */
export function indexAppendedTranscriptEventInTransaction(
  db: DatabaseSync,
  params: {
    sessionId: string;
    seq: number;
    event: unknown;
    eventId: string | null;
    createdAt: number;
  },
): boolean {
  const watermark = readSessionTranscriptProjectionState(db, params.sessionId);
  if (!watermark) {
    if (params.seq !== 0) {
      // Pre-existing rows without index state (e.g. doctor-migrated
      // transcripts): stay unindexed until reconcile rebuilds the session.
      return true;
    }
    applyForwardIndex(db, params, {
      activeEventCount: 0,
      activeMessageCount: 0,
      indexedSeq: -1,
      leafEventId: null,
      needsRebuild: false,
    });
    return false;
  }
  if (watermark.needsRebuild) {
    return true;
  }
  if (params.seq !== watermark.indexedSeq + 1) {
    // Out-of-band writes bypassed the hook; reconcile recomputes the truth.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return true;
  }
  if (
    isSessionTranscriptLeafControl(params.event) ||
    isSessionTranscriptSideAppendEntry(params.event)
  ) {
    // Leaf controls repoint the active branch and side appends attach off
    // the main chain; the visible path must be re-resolved rather than
    // guessed at append time.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return true;
  }
  const isCanonicalEvent = isCanonicalSessionTranscriptEntry(params.event);
  if (isCanonicalEvent && watermark.leafEventId === null && watermark.activeEventCount > 0) {
    // A canonical tree supersedes legacy flat message rows. Re-resolve once
    // instead of retaining rows that are no longer on the selected path.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return true;
  }
  const treeEntry = parseSessionTranscriptTreeEntry(params.event);
  if (
    !isCanonicalEvent &&
    watermark.leafEventId !== null &&
    shouldProjectActiveEvent(params.event)
  ) {
    // A noncanonical row after a tracked tree cursor may be a flat fallback or
    // an opaque append ancestor. Only the full resolver can decide visibility.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return true;
  }
  if (treeEntry && treeEntry.parentId !== watermark.leafEventId) {
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return true;
  }
  applyForwardIndex(db, params, watermark);
  return false;
}

function applyForwardIndex(
  db: DatabaseSync,
  params: {
    sessionId: string;
    seq: number;
    event: unknown;
    eventId: string | null;
    createdAt: number;
  },
  watermark: SessionTranscriptProjectionState,
): void {
  const entry = extractTranscriptIndexEntry(params.event, params.createdAt);
  if (entry) {
    insertFtsRow(db, params.sessionId, entry);
  }
  const projectsActiveEvent = shouldProjectActiveEvent(params.event);
  const projectsMessage = projectsActiveEvent && hasTranscriptMessage(params.event);
  if (projectsActiveEvent) {
    insertActiveEventRow(db, {
      activePosition: watermark.activeEventCount,
      eventSeq: params.seq,
      messagePosition: projectsMessage ? watermark.activeMessageCount : null,
      sessionId: params.sessionId,
    });
  }
  // Mirror scanSessionTranscriptTree's leaf advancement: canonical entries
  // (parent-linked or parentless) become the tip the next append chains to;
  // headers and unknown control rows leave the tip untouched.
  const advancesLeaf = params.eventId !== null && isCanonicalSessionTranscriptEntry(params.event);
  writeWatermark(
    db,
    params.sessionId,
    {
      activeEventCount: watermark.activeEventCount + (projectsActiveEvent ? 1 : 0),
      activeMessageCount: watermark.activeMessageCount + (projectsMessage ? 1 : 0),
      indexedSeq: params.seq,
      leafEventId: advancesLeaf ? params.eventId : watermark.leafEventId,
      needsRebuild: false,
    },
    params.createdAt,
  );
}

/** Marks one session for lazy rebuild without touching its FTS rows. */
export function markSessionTranscriptIndexDirtyInTransaction(
  db: DatabaseSync,
  sessionId: string,
): void {
  const now = Date.now();
  const watermark = readSessionTranscriptProjectionState(db, sessionId);
  writeWatermark(
    db,
    sessionId,
    {
      activeEventCount: watermark?.activeEventCount ?? 0,
      activeMessageCount: watermark?.activeMessageCount ?? 0,
      indexedSeq: watermark?.indexedSeq ?? -1,
      leafEventId: watermark?.leafEventId ?? null,
      needsRebuild: true,
    },
    now,
  );
}

/** In-transaction delete hook: drops index rows alongside transcript rows. */
export function deleteSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
): void {
  deleteFtsRows(db, sessionId);
  deleteActiveEventRows(db, sessionId);
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .deleteFrom("session_transcript_index_state")
      .where("session_id", "=", sessionId),
  );
}

/**
 * Rebuilds one session's index from its full event set: drops existing FTS
 * rows, indexes the resolved active branch, and resets the watermark to the
 * same append parent the accessor's next append will resolve.
 */
function rebuildSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
  rows: readonly SessionTranscriptProjectionSourceRow[],
): void {
  const projection = buildSessionTranscriptProjection({
    rows,
    sessionId,
    sourceTranscriptUpdatedAt: null,
  });
  deleteFtsRows(db, sessionId);
  deleteActiveEventRows(db, sessionId);
  for (const entry of projection.ftsRows) {
    insertFtsRow(db, sessionId, entry);
  }
  for (const row of projection.activeRows) {
    insertActiveEventRow(db, { ...row, sessionId });
  }
  writeWatermark(
    db,
    sessionId,
    {
      activeEventCount: projection.activeEventCount,
      activeMessageCount: projection.activeMessageCount,
      indexedSeq: projection.sourceIndexedSeq,
      leafEventId: projection.leafEventId,
      needsRebuild: false,
    },
    Date.now(),
  );
}

/** Rebuilds one lagging projection under its current write transaction. */
export function reconcileSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!latest) {
    deleteSessionTranscriptIndexInTransaction(db, sessionId);
    return false;
  }
  if (!sessionTranscriptIndexNeedsReconcile(db, sessionId)) {
    return false;
  }
  const rows = executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events")
      .select(["event_json", "seq", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  rebuildSessionTranscriptIndexInTransaction(
    db,
    sessionId,
    rows.map((row) => ({
      event: JSON.parse(row.event_json) as unknown,
      seq: row.seq,
      createdAt: row.created_at,
    })),
  );
  return true;
}

/**
 * Sessions whose index needs reconcile work: flagged rebuilds, transcripts
 * that gained rows without index state (doctor imports), and watermarks
 * behind the newest row. Ordered for deterministic reconcile passes.
 */
export function listSessionsNeedingTranscriptIndexReconcile(db: DatabaseSync): string[] {
  const kysely = getIndexKysely(db);
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_windows")
      .innerJoin("transcript_events as latest", (join) =>
        join
          .onRef("latest.session_id", "=", "session_windows.session_id")
          .on((eb) =>
            eb(
              "latest.seq",
              "=",
              eb
                .selectFrom("transcript_events as candidate")
                .select("candidate.seq")
                .whereRef("candidate.session_id", "=", "session_windows.session_id")
                .orderBy("candidate.seq", "desc")
                .limit(1),
            ),
          ),
      )
      .leftJoin(
        "session_transcript_index_state as st",
        "st.session_id",
        "session_windows.session_id",
      )
      .select("session_windows.session_id")
      .where((eb) =>
        eb.or([
          eb(eb.fn.coalesce("st.needs_rebuild", eb.val(1)), "!=", 0),
          eb("latest.seq", ">", eb.fn.coalesce("st.indexed_seq", eb.val(-1))),
        ]),
      )
      // The transcript PK makes the correlated latest-row lookup one index seek per session.
      // Grouping transcript_events here made every healthy search rescan the entire history.
      .orderBy("session_windows.session_id"),
  ).rows;
  return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
}

/** Drops index rows for sessions whose transcript rows are gone. */
export function deleteOrphanedTranscriptIndexRowsInTransaction(db: DatabaseSync): void {
  const kysely = getIndexKysely(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_active_events")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_fts")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_transcript_index_state")
      .where(
        "session_id",
        "not in",
        kysely.selectFrom("transcript_events").select("session_id").distinct(),
      ),
  );
}
