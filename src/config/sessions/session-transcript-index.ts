// Transcript FTS index maintenance shared by the SQLite session accessor
// (in-transaction hooks) and session-transcript-search (reconcile + query).
// The index mirrors the ACTIVE transcript branch only. Invariant: the
// watermark's leaf_event_id always equals the append parent the accessor
// would resolve next; an append that chains onto it forward-indexes in the
// same transaction, anything ambiguous (leaf controls, branch switches)
// marks the session dirty and the next search rebuilds it from the same
// visible-path resolution sessions_history uses.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  isSessionTranscriptSideAppendEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import {
  resolveVisibleTranscriptAppendParentId,
  selectVisibleTranscriptEventEntries,
} from "./transcript-visible-events.js";

type TranscriptIndexDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_fts" | "session_transcript_index_state" | "transcript_events"
>;

export type TranscriptIndexEntry = {
  messageId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

type TranscriptIndexWatermark = {
  indexedSeq: number;
  leafEventId: string | null;
  needsRebuild: boolean;
};

function getIndexKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptIndexDatabase>(db);
}

function readMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as { content?: unknown; role?: unknown; text?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content.trim() || undefined;
  }
  if (typeof record.text === "string") {
    return record.text.trim() || undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const parts = record.content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [];
    }
    const part = block as { text?: unknown; type?: unknown };
    if (part.type !== "text" && part.type !== "input_text" && part.type !== "output_text") {
      return [];
    }
    return typeof part.text === "string" && part.text.trim() ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extracts the searchable payload from one transcript event. Only user and
 * assistant message text is indexed; tool results, reasoning blocks, and
 * images stay out of the index by construction.
 */
export function extractTranscriptIndexEntry(
  event: unknown,
  fallbackTimestamp: number,
): TranscriptIndexEntry | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as { id?: unknown; message?: unknown; timestamp?: unknown; type?: unknown };
  if (record.type !== "message" || typeof record.id !== "string" || !record.id.trim()) {
    return undefined;
  }
  const message = record.message as { role?: unknown } | undefined;
  const role = message?.role;
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const text = readMessageText(message);
  if (!text) {
    return undefined;
  }
  const timestamp =
    typeof record.timestamp === "number"
      ? record.timestamp
      : typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
  return {
    messageId: record.id.trim(),
    role,
    text,
    timestamp: Number.isFinite(timestamp) ? timestamp : fallbackTimestamp,
  };
}

function readWatermark(db: DatabaseSync, sessionId: string): TranscriptIndexWatermark | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getIndexKysely(db)
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "leaf_event_id", "needs_rebuild"])
      .where("session_id", "=", sessionId),
  );
  if (!row) {
    return undefined;
  }
  return {
    indexedSeq: row.indexed_seq,
    leafEventId: row.leaf_event_id,
    needsRebuild: row.needs_rebuild !== 0,
  };
}

function writeWatermark(
  db: DatabaseSync,
  sessionId: string,
  watermark: TranscriptIndexWatermark,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .insertInto("session_transcript_index_state")
      .values({
        session_id: sessionId,
        indexed_seq: watermark.indexedSeq,
        leaf_event_id: watermark.leafEventId,
        needs_rebuild: watermark.needsRebuild ? 1 : 0,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          indexed_seq: watermark.indexedSeq,
          leaf_event_id: watermark.leafEventId,
          needs_rebuild: watermark.needsRebuild ? 1 : 0,
          updated_at: now,
        }),
      ),
  );
}

function insertFtsRow(db: DatabaseSync, sessionId: string, entry: TranscriptIndexEntry): void {
  executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .insertInto("session_transcript_fts")
      .values({
        text: entry.text,
        session_id: sessionId,
        message_id: entry.messageId,
        role: entry.role,
        // FTS5 aux columns are typeless, so codegen types them as string;
        // SQLite stores the numeric timestamp natively and readers normalize.
        timestamp: entry.timestamp as unknown as string,
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
): void {
  const watermark = readWatermark(db, params.sessionId);
  if (!watermark) {
    if (params.seq !== 0) {
      // Pre-existing rows without index state (e.g. doctor-migrated
      // transcripts): stay unindexed until reconcile rebuilds the session.
      return;
    }
    applyForwardIndex(db, params, { indexedSeq: -1, leafEventId: null, needsRebuild: false });
    return;
  }
  if (watermark.needsRebuild) {
    return;
  }
  if (params.seq !== watermark.indexedSeq + 1) {
    // Out-of-band writes bypassed the hook; reconcile recomputes the truth.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return;
  }
  if (
    isSessionTranscriptLeafControl(params.event) ||
    isSessionTranscriptSideAppendEntry(params.event)
  ) {
    // Leaf controls repoint the active branch and side appends attach off
    // the main chain; the visible path must be re-resolved rather than
    // guessed at append time.
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return;
  }
  const treeEntry = parseSessionTranscriptTreeEntry(params.event);
  if (treeEntry && treeEntry.parentId !== watermark.leafEventId) {
    markSessionTranscriptIndexDirtyInTransaction(db, params.sessionId);
    return;
  }
  applyForwardIndex(db, params, watermark);
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
  watermark: TranscriptIndexWatermark,
): void {
  const entry = extractTranscriptIndexEntry(params.event, params.createdAt);
  if (entry) {
    insertFtsRow(db, params.sessionId, entry);
  }
  // Mirror scanSessionTranscriptTree's leaf advancement: canonical entries
  // (parent-linked or parentless) become the tip the next append chains to;
  // headers and unknown control rows leave the tip untouched.
  const advancesLeaf = params.eventId !== null && isCanonicalSessionTranscriptEntry(params.event);
  writeWatermark(
    db,
    params.sessionId,
    {
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
  const watermark = readWatermark(db, sessionId);
  writeWatermark(
    db,
    sessionId,
    {
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
export function rebuildSessionTranscriptIndexInTransaction(
  db: DatabaseSync,
  sessionId: string,
  events: readonly unknown[],
  maxSeq: number,
): void {
  deleteFtsRows(db, sessionId);
  const now = Date.now();
  for (const entry of selectVisibleTranscriptEventEntries(events)) {
    const indexed = extractTranscriptIndexEntry(entry.event, now);
    if (indexed) {
      insertFtsRow(db, sessionId, indexed);
    }
  }
  writeWatermark(
    db,
    sessionId,
    {
      indexedSeq: maxSeq,
      leafEventId: resolveVisibleTranscriptAppendParentId(events),
      needsRebuild: false,
    },
    now,
  );
}

/**
 * Sessions whose index needs reconcile work: flagged rebuilds, transcripts
 * that gained rows without index state (doctor imports), and watermarks
 * behind the newest row. Ordered for deterministic reconcile passes.
 */
export function listSessionsNeedingTranscriptIndexReconcile(db: DatabaseSync): string[] {
  const rows = executeSqliteQuerySync(
    db,
    getIndexKysely(db)
      .selectFrom("transcript_events as te")
      .leftJoin("session_transcript_index_state as st", "st.session_id", "te.session_id")
      .select("te.session_id")
      .groupBy("te.session_id")
      .having((eb) =>
        eb.or([
          eb(eb.fn.coalesce(eb.fn.max("st.needs_rebuild"), eb.val(1)), "!=", 0),
          eb(eb.fn.max("te.seq"), ">", eb.fn.coalesce(eb.fn.max("st.indexed_seq"), eb.val(-1))),
        ]),
      )
      .orderBy("te.session_id"),
  ).rows;
  return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
}

/** Drops index rows for sessions whose transcript rows are gone. */
export function deleteOrphanedTranscriptIndexRowsInTransaction(db: DatabaseSync): void {
  const kysely = getIndexKysely(db);
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
