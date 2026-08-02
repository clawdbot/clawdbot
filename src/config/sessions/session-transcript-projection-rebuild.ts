import type { DatabaseSync } from "node:sqlite";
import { sql, type Generated } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
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

type TranscriptProjectionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_windows"
  | "session_transcript_index_state"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
> & {
  session_transcript_active_events: OpenClawAgentKyselyDatabase["session_transcript_active_events"] & {
    rowid: Generated<number>;
  };
  session_transcript_fts: OpenClawAgentKyselyDatabase["session_transcript_fts"] & {
    rowid: Generated<number>;
  };
};

export type TranscriptIndexEntry = {
  messageId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

export type PreparedSessionTranscriptProjectionMetadata = {
  activeEventCount: number;
  activeMessageCount: number;
  leafEventId: string | null;
  sessionId: string;
  sourceIndexedSeq: number;
  sourceTranscriptGeneration: string | null;
  sourceTranscriptUpdatedAt: number | null;
};

export type PreparedSessionTranscriptProjection = PreparedSessionTranscriptProjectionMetadata & {
  activeRows: Array<{
    activePosition: number;
    eventSeq: number;
    messagePosition: number | null;
  }>;
  ftsRows: TranscriptIndexEntry[];
};

export type SessionTranscriptProjectionSourceRow = {
  createdAt: number;
  event: unknown;
  seq: number;
};

type ProjectionDeleteChunkResult = {
  hasMore: boolean;
  owned: boolean;
};

type SessionTranscriptProjectionCursor = {
  activeEventCount: number;
  activeMessageCount: number;
  indexedSeq: number;
  leafEventId: string | null;
};

export type PreparedSessionTranscriptProjectionAppend = {
  activeRow?: PreparedSessionTranscriptProjection["activeRows"][number];
  cursor: SessionTranscriptProjectionCursor;
  ftsRow?: TranscriptIndexEntry;
};

type TranscriptProjectionSourceSnapshot = {
  generation: string | null;
  latestSeq: number | undefined;
  transcriptUpdatedAt: number | null;
};

const PROJECTION_FINALIZE_TAIL_ROWS = 512;
const PROJECTION_FINALIZE_TAIL_BYTES = 256 * 1024;

function transcriptEventStoredByteLength() {
  return /* kysely-allow-raw: byte bounds measure stored UTF-8 event_json bytes. */ sql<number>`length(CAST(event_json AS BLOB))`.as(
    "event_bytes",
  );
}

function getProjectionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptProjectionDatabase>(db);
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

/** Extracts the searchable user/assistant text from one transcript event. */
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

export function hasTranscriptMessage(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    !Array.isArray(event) &&
    Object.hasOwn(event, "message") &&
    (event as { message?: unknown }).message !== undefined
  );
}

export function shouldProjectActiveEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const record = event as { type?: unknown };
  if (record.type === "session") {
    return false;
  }
  return (
    isCanonicalSessionTranscriptEntry(event) ||
    parseSessionTranscriptTreeEntry(event) !== undefined ||
    hasTranscriptMessage(event)
  );
}

function readCanonicalEventId(event: unknown): string | null {
  if (!isCanonicalSessionTranscriptEntry(event)) {
    return null;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function changesPriorProjectionVisibility(event: unknown): boolean {
  return isCanonicalSessionTranscriptEntry(event) && event.type === "reset";
}

/** Resolves one append against an already-complete projection without mutating storage. */
export function prepareSessionTranscriptProjectionAppend(params: {
  createdAt: number;
  cursor: SessionTranscriptProjectionCursor;
  event: unknown;
  eventId: string | null;
  seq: number;
}): PreparedSessionTranscriptProjectionAppend | undefined {
  const { cursor } = params;
  if (
    params.seq !== cursor.indexedSeq + 1 ||
    isSessionTranscriptLeafControl(params.event) ||
    isSessionTranscriptSideAppendEntry(params.event)
  ) {
    return undefined;
  }
  const isCanonicalEvent = isCanonicalSessionTranscriptEntry(params.event);
  if (isCanonicalEvent && cursor.leafEventId === null && cursor.activeEventCount > 0) {
    return undefined;
  }
  const treeEntry = parseSessionTranscriptTreeEntry(params.event);
  if (
    (!isCanonicalEvent && cursor.leafEventId !== null && shouldProjectActiveEvent(params.event)) ||
    (treeEntry && treeEntry.parentId !== cursor.leafEventId)
  ) {
    return undefined;
  }

  const ftsRow = extractTranscriptIndexEntry(params.event, params.createdAt);
  const projectsActiveEvent = shouldProjectActiveEvent(params.event);
  const projectsMessage = projectsActiveEvent && hasTranscriptMessage(params.event);
  const activeRow = projectsActiveEvent
    ? {
        activePosition: cursor.activeEventCount,
        eventSeq: params.seq,
        messagePosition: projectsMessage ? cursor.activeMessageCount : null,
      }
    : undefined;
  return {
    ...(activeRow ? { activeRow } : {}),
    cursor: {
      activeEventCount: cursor.activeEventCount + (projectsActiveEvent ? 1 : 0),
      activeMessageCount: cursor.activeMessageCount + (projectsMessage ? 1 : 0),
      indexedSeq: params.seq,
      leafEventId:
        params.eventId !== null && isCanonicalEvent ? params.eventId : cursor.leafEventId,
    },
    ...(ftsRow ? { ftsRow } : {}),
  };
}

/** Builds the same active-branch and search projection for worker and in-transaction owners. */
export function buildSessionTranscriptProjection(params: {
  rows: readonly SessionTranscriptProjectionSourceRow[];
  sessionId: string;
  sourceTranscriptGeneration: string | null;
  sourceTranscriptUpdatedAt: number | null;
}): PreparedSessionTranscriptProjection {
  const now = Date.now();
  const events = params.rows.map((row) => row.event);
  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const ftsRows: TranscriptIndexEntry[] = [];
  let activeMessageCount = 0;

  for (const entry of selectVisibleTranscriptEventEntries(events)) {
    const source = params.rows[entry.seq - 1];
    // Forward appends and both rebuild owners must give timestamp-less events
    // the same persisted source timestamp, not the time a projection ran.
    const indexed = extractTranscriptIndexEntry(entry.event, source?.createdAt ?? now);
    if (indexed) {
      ftsRows.push(indexed);
    }
    if (!source || !shouldProjectActiveEvent(entry.event)) {
      continue;
    }
    const projectsMessage = hasTranscriptMessage(entry.event);
    activeRows.push({
      activePosition: activeRows.length,
      eventSeq: source.seq,
      messagePosition: projectsMessage ? activeMessageCount : null,
    });
    if (projectsMessage) {
      activeMessageCount += 1;
    }
  }

  return {
    activeEventCount: activeRows.length,
    activeMessageCount,
    activeRows,
    ftsRows,
    leafEventId: resolveVisibleTranscriptAppendParentId(events),
    sessionId: params.sessionId,
    sourceIndexedSeq: params.rows.at(-1)?.seq ?? -1,
    sourceTranscriptGeneration: params.sourceTranscriptGeneration,
    sourceTranscriptUpdatedAt: params.sourceTranscriptUpdatedAt,
  };
}

/** Reads and resolves one projection on a worker-owned SQLite snapshot. */
export function prepareSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
): PreparedSessionTranscriptProjection | undefined {
  return runSqliteDeferredTransactionSync(
    db,
    () => {
      const kysely = getProjectionKysely(db);
      const session = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_windows as session")
          .leftJoin(
            "transcript_rewrite_watermarks as watermark",
            "watermark.session_id",
            "session.session_id",
          )
          .select(["session.transcript_updated_at", "watermark.generation"])
          .where("session.session_id", "=", sessionId),
      );
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("transcript_events")
          .select(["event_json", "seq", "created_at"])
          .where("session_id", "=", sessionId)
          .orderBy("seq", "asc"),
      ).rows;
      if (!session || rows.length === 0) {
        return undefined;
      }

      return buildSessionTranscriptProjection({
        rows: rows.map((row) => ({
          createdAt: row.created_at,
          event: JSON.parse(row.event_json) as unknown,
          seq: row.seq,
        })),
        sessionId,
        sourceTranscriptGeneration: session.generation ?? null,
        sourceTranscriptUpdatedAt: session.transcript_updated_at,
      });
    },
    {
      databaseLabel: "agent transcript projection",
      operationLabel: "sessions.transcript-index.prepare",
    },
  );
}

function readProjectionSourceSnapshot(
  db: DatabaseSync,
  sessionId: string,
): TranscriptProjectionSourceSnapshot {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows as session")
      .leftJoin(
        "transcript_rewrite_watermarks as watermark",
        "watermark.session_id",
        "session.session_id",
      )
      .select(["session.transcript_updated_at", "watermark.generation"])
      .where("session.session_id", "=", sessionId),
  );
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return {
    generation: session?.generation ?? null,
    latestSeq: latest?.seq,
    transcriptUpdatedAt: session?.transcript_updated_at ?? null,
  };
}

function sourceSnapshotMatches(
  snapshot: TranscriptProjectionSourceSnapshot,
  plan: PreparedSessionTranscriptProjectionMetadata,
): boolean {
  return (
    snapshot.generation === plan.sourceTranscriptGeneration &&
    snapshot.latestSeq === plan.sourceIndexedSeq &&
    snapshot.transcriptUpdatedAt === plan.sourceTranscriptUpdatedAt
  );
}

function sourceSnapshotCanBeClaimed(
  snapshot: TranscriptProjectionSourceSnapshot,
  plan: PreparedSessionTranscriptProjectionMetadata,
): boolean {
  if (sourceSnapshotMatches(snapshot, plan)) {
    return true;
  }
  return (
    plan.sourceTranscriptGeneration !== null &&
    snapshot.generation === plan.sourceTranscriptGeneration &&
    snapshot.latestSeq !== undefined &&
    snapshot.latestSeq > plan.sourceIndexedSeq
  );
}

function projectionTailFitsCatchUpBounds(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  snapshot: TranscriptProjectionSourceSnapshot,
): boolean {
  if (
    plan.sourceTranscriptGeneration === null ||
    snapshot.generation !== plan.sourceTranscriptGeneration ||
    snapshot.latestSeq === undefined ||
    snapshot.latestSeq < plan.sourceIndexedSeq
  ) {
    return false;
  }
  const tailRowCount = snapshot.latestSeq - plan.sourceIndexedSeq;
  if (tailRowCount > PROJECTION_FINALIZE_TAIL_ROWS) {
    return false;
  }
  const sizeRows = executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventStoredByteLength()])
      .where("session_id", "=", plan.sessionId)
      .where("seq", ">", plan.sourceIndexedSeq)
      .orderBy("seq", "asc")
      .limit(PROJECTION_FINALIZE_TAIL_ROWS + 1),
  ).rows;
  return (
    sizeRows.length === tailRowCount &&
    (sizeRows.at(-1)?.seq ?? plan.sourceIndexedSeq) === snapshot.latestSeq &&
    sizeRows.reduce((total, row) => total + row.event_bytes, 0) <= PROJECTION_FINALIZE_TAIL_BYTES
  );
}

function projectionClaimIsOwned(db: DatabaseSync, sessionId: string, claimId: number): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getProjectionKysely(db)
      .selectFrom("session_transcript_index_state")
      .select(["needs_rebuild", "updated_at"])
      .where("session_id", "=", sessionId),
  );
  return row?.needs_rebuild !== 0 && row?.updated_at === claimId;
}

/** Claims a prepared snapshot. Later chunks publish only while this claim remains current. */
export function claimPreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  const sourceSnapshot = readProjectionSourceSnapshot(db, plan.sessionId);
  if (
    !sourceSnapshotCanBeClaimed(sourceSnapshot, plan) ||
    (!sourceSnapshotMatches(sourceSnapshot, plan) &&
      !projectionTailFitsCatchUpBounds(db, plan, sourceSnapshot))
  ) {
    return false;
  }
  const kysely = getProjectionKysely(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild"])
      .where("session_id", "=", plan.sessionId),
  );
  if (current?.needs_rebuild === 0 && current.indexed_seq === sourceSnapshot.latestSeq) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("session_transcript_index_state")
      .values({
        active_event_count: 0,
        active_message_count: 0,
        indexed_seq: -1,
        leaf_event_id: null,
        needs_rebuild: 1,
        session_id: plan.sessionId,
        updated_at: claimId,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          active_event_count: 0,
          active_message_count: 0,
          indexed_seq: -1,
          leaf_event_id: null,
          needs_rebuild: 1,
          updated_at: claimId,
        }),
      ),
  );
  return true;
}

function insertPreparedSessionTranscriptProjectionRows(
  db: DatabaseSync,
  params: {
    activeRows?: PreparedSessionTranscriptProjection["activeRows"];
    ftsRows?: PreparedSessionTranscriptProjection["ftsRows"];
    sessionId: string;
  },
): void {
  const kysely = getProjectionKysely(db);
  if (params.activeRows && params.activeRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_active_events").values(
        params.activeRows.map((row) => ({
          active_position: row.activePosition,
          event_seq: row.eventSeq,
          message_position: row.messagePosition,
          session_id: params.sessionId,
        })),
      ),
    );
  }
  if (params.ftsRows && params.ftsRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values(
        params.ftsRows.map((row) => ({
          message_id: row.messageId,
          role: row.role,
          session_id: params.sessionId,
          text: row.text,
          timestamp: row.timestamp as unknown as string,
        })),
      ),
    );
  }
}

/** Deletes old rows in bounded rowid batches while the prepared claim is current. */
export function deletePreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: { claimId: number; maxRowsPerTable: number; sessionId: string },
): ProjectionDeleteChunkResult {
  if (!projectionClaimIsOwned(db, params.sessionId, params.claimId)) {
    return { hasMore: false, owned: false };
  }
  // Hidden rowid batching is the narrow SQLite primitive that keeps each
  // writer transaction bounded for both ordinary and FTS5 projection rows.
  const kysely = getProjectionKysely(db);
  const active = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_active_events")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_active_events")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  const fts = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_fts")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_fts")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  return {
    hasMore: active === params.maxRowsPerTable || fts === params.maxRowsPerTable,
    owned: true,
  };
}

/** Appends one bounded projection chunk while its claim remains current. */
export function appendPreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: {
    activeRows?: PreparedSessionTranscriptProjection["activeRows"];
    claimId: number;
    ftsRows?: PreparedSessionTranscriptProjection["ftsRows"];
    sessionId: string;
  },
): boolean {
  if (!projectionClaimIsOwned(db, params.sessionId, params.claimId)) {
    return false;
  }
  insertPreparedSessionTranscriptProjectionRows(db, params);
  return true;
}

function prepareProjectionTailCatchUp(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  snapshot: TranscriptProjectionSourceSnapshot,
): PreparedSessionTranscriptProjection | undefined {
  const latestSeq = snapshot.latestSeq;
  if (latestSeq === undefined || !projectionTailFitsCatchUpBounds(db, plan, snapshot)) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .selectFrom("transcript_events")
      .select(["event_json", "seq", "created_at"])
      .where("session_id", "=", plan.sessionId)
      .where("seq", ">", plan.sourceIndexedSeq)
      .where("seq", "<=", latestSeq)
      .orderBy("seq", "asc"),
  ).rows;

  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const ftsRows: PreparedSessionTranscriptProjection["ftsRows"] = [];
  let cursor: SessionTranscriptProjectionCursor = {
    activeEventCount: plan.activeEventCount,
    activeMessageCount: plan.activeMessageCount,
    indexedSeq: plan.sourceIndexedSeq,
    leafEventId: plan.leafEventId,
  };
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as unknown;
    // Reset-window reads can interpret this control after a live append, but
    // catch-up must not publish a tail that changes visibility of earlier rows.
    if (changesPriorProjectionVisibility(event)) {
      return undefined;
    }
    const append = prepareSessionTranscriptProjectionAppend({
      createdAt: row.created_at,
      cursor,
      event,
      eventId: readCanonicalEventId(event),
      seq: row.seq,
    });
    if (!append) {
      return undefined;
    }
    cursor = append.cursor;
    if (append.activeRow) {
      activeRows.push(append.activeRow);
    }
    if (append.ftsRow) {
      ftsRows.push(append.ftsRow);
    }
  }
  return {
    ...plan,
    activeEventCount: cursor.activeEventCount,
    activeMessageCount: cursor.activeMessageCount,
    activeRows,
    ftsRows,
    leafEventId: cursor.leafEventId,
    sourceIndexedSeq: cursor.indexedSeq,
    sourceTranscriptUpdatedAt: snapshot.transcriptUpdatedAt,
  };
}

/** Publishes one current snapshot, catching up a row-and-byte-bounded append-only tail. */
export function finalizePreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (!projectionClaimIsOwned(db, plan.sessionId, claimId)) {
    return false;
  }
  const snapshot = readProjectionSourceSnapshot(db, plan.sessionId);
  const exactSnapshot = sourceSnapshotMatches(snapshot, plan);
  const catchUpPlan = exactSnapshot ? undefined : prepareProjectionTailCatchUp(db, plan, snapshot);
  if (!exactSnapshot && !catchUpPlan) {
    return false;
  }
  const finalPlan = catchUpPlan ?? plan;
  if (catchUpPlan) {
    insertPreparedSessionTranscriptProjectionRows(db, {
      activeRows: catchUpPlan.activeRows,
      ftsRows: catchUpPlan.ftsRows,
      sessionId: catchUpPlan.sessionId,
    });
  }
  executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .updateTable("session_transcript_index_state")
      .set({
        active_event_count: finalPlan.activeEventCount,
        active_message_count: finalPlan.activeMessageCount,
        indexed_seq: finalPlan.sourceIndexedSeq,
        leaf_event_id: finalPlan.leafEventId,
        needs_rebuild: 0,
        updated_at: Date.now(),
      })
      .where("session_id", "=", finalPlan.sessionId)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", claimId),
  );
  return true;
}
