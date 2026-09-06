import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ColumnType, Generated, InferResult } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  isCanonicalSessionTranscriptEntry,
  parseSessionTranscriptTreeEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type TranscriptProjectionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "session_transcript_index_state" | "transcript_events"
> & {
  session_transcript_active_events: OpenClawAgentKyselyDatabase["session_transcript_active_events"] & {
    rowid: Generated<number>;
  };
  session_transcript_fts: Omit<
    OpenClawAgentKyselyDatabase["session_transcript_fts"],
    "timestamp"
  > & {
    rowid: Generated<number>;
    timestamp: ColumnType<string | null, number | string | null, number | string | null>;
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
  sourceTranscriptUpdatedAt: number | null;
};

export type PreparedSessionTranscriptProjection = PreparedSessionTranscriptProjectionMetadata & {
  activeRows: Array<{
    activePosition: number;
    contextEligible: 0 | 1;
    eventSeq: number;
    messagePosition: number | null;
  }>;
  ftsRows: TranscriptIndexEntry[];
};

type ProjectionDeleteChunkResult = {
  hasMore: boolean;
  owned: boolean;
};

export type SessionTranscriptProjectionRow = {
  event_json: string;
  seq: number;
  created_at: number;
};

type SessionTranscriptProjectionSource = {
  sessionId: string;
  transcriptUpdatedAt: number | null;
  rows: () => Iterable<SessionTranscriptProjectionRow>;
  row: (seq: number) => SessionTranscriptProjectionRow | undefined;
};

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

/** Control facts still belong in bounded context acquisition, even without a replay message. */
export function transcriptEventContextEligibility(event: unknown): 0 | 1 {
  return isRecord(event) && isRecord(event.message) && event.message.excludeFromContext === true
    ? 0
    : 1;
}

/** Older same-version writers can leave a current watermark over unclassified rows. */
export function hasUnclassifiedSessionTranscriptEvents(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getProjectionKysely(db)
        .selectFrom("session_transcript_active_events")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .where("context_eligible", "is", null)
        .limit(1),
    ) !== undefined
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

/** Streams projection payloads; only navigation metadata is retained for branch resolution. */
export function visitSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
  visitor: {
    activeRow: (row: PreparedSessionTranscriptProjection["activeRows"][number]) => void;
    ftsRow: (row: TranscriptIndexEntry) => void;
  },
): PreparedSessionTranscriptProjectionMetadata | undefined {
  const source = readProjectionSource(db, sessionId);
  return source ? visitProjectionSource(source, visitor) : undefined;
}

function readProjectionSource(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptProjectionSource | undefined {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows")
      .select("transcript_updated_at")
      .where("session_id", "=", sessionId),
  );
  if (!session) {
    return undefined;
  }
  const query = kysely
    .selectFrom("transcript_events")
    .select(["event_json", "seq", "created_at"])
    .where("session_id", "=", sessionId);
  const read = prepareSqliteQuerySync<number, InferResult<typeof query>[number]>(db, (parameter) =>
    query.where(
      "seq",
      "=",
      parameter((seq) => seq),
    ),
  );
  return {
    sessionId,
    transcriptUpdatedAt: session.transcript_updated_at,
    rows: () => iterateSqliteQuerySync(db, query.orderBy("seq", "asc")),
    row: (seq) => read(seq).rows[0],
  };
}

function visitProjectionSource(
  source: SessionTranscriptProjectionSource,
  visitor: Parameters<typeof visitSessionTranscriptProjection>[2],
): PreparedSessionTranscriptProjectionMetadata | undefined {
  let sourceIndexedSeq = -1;
  const tree = scanSessionTranscriptTree(
    (function* () {
      for (const row of source.rows()) {
        sourceIndexedSeq = row.seq;
        const event: unknown = JSON.parse(row.event_json);
        const navigation: Record<string, unknown> & { seq: number } = { seq: row.seq };
        if (isRecord(event)) {
          // Preserve own-property presence, including malformed controls, without retaining
          // message/tool/compaction payloads in the ancestry graph.
          for (const key of [
            "type",
            "id",
            "parentId",
            "targetId",
            "appendParentId",
            "appendMode",
          ]) {
            if (Object.hasOwn(event, key)) {
              navigation[key] = event[key];
            }
          }
        }
        yield navigation;
      }
    })(),
  );
  if (sourceIndexedSeq < 0) {
    return undefined;
  }
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const rows =
    visiblePath.length > 0
      ? (function* () {
          for (const node of visiblePath) {
            const row = source.row(node.entry.seq);
            if (row) {
              yield row;
            }
          }
        })()
      : tree.hasLeafControl
        ? []
        : source.rows();
  let activeEventCount = 0;
  let activeMessageCount = 0;
  for (const row of rows) {
    const event: unknown = JSON.parse(row.event_json);
    const indexed = extractTranscriptIndexEntry(event, row.created_at);
    if (indexed) {
      visitor.ftsRow(indexed);
    }
    if (!shouldProjectActiveEvent(event)) {
      continue;
    }
    const projectsMessage = hasTranscriptMessage(event);
    visitor.activeRow({
      activePosition: activeEventCount++,
      contextEligible: transcriptEventContextEligibility(event),
      eventSeq: row.seq,
      messagePosition: projectsMessage ? activeMessageCount++ : null,
    });
  }
  return {
    activeEventCount,
    activeMessageCount,
    leafEventId: tree.appendParentId,
    sessionId: source.sessionId,
    sourceIndexedSeq,
    sourceTranscriptUpdatedAt: source.transcriptUpdatedAt,
  };
}

function prepareProjectionSource(
  source: SessionTranscriptProjectionSource,
): PreparedSessionTranscriptProjection | undefined {
  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const ftsRows: TranscriptIndexEntry[] = [];
  const metadata = visitProjectionSource(source, {
    activeRow: (row) => activeRows.push(row),
    ftsRow: (row) => ftsRows.push(row),
  });
  return metadata ? { ...metadata, activeRows, ftsRows } : undefined;
}

/** The worker owns these ordered raw rows; memory-backed transcripts never reopen a path. */
export function prepareMemorySessionTranscriptProjection(
  sessionId: string,
  transcriptUpdatedAt: number | null,
  rows: ReadonlyMap<number, SessionTranscriptProjectionRow>,
): PreparedSessionTranscriptProjection | undefined {
  return prepareProjectionSource({
    sessionId,
    transcriptUpdatedAt,
    rows: () => rows.values(),
    row: (seq) => rows.get(seq),
  });
}

/** Reads and resolves one projection on a worker-owned SQLite snapshot. */
export function prepareSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
): PreparedSessionTranscriptProjection | undefined {
  return runSqliteDeferredTransactionSync(
    db,
    () => {
      const source = readProjectionSource(db, sessionId);
      return source ? prepareProjectionSource(source) : undefined;
    },
    {
      databaseLabel: "agent transcript projection",
      operationLabel: "sessions.transcript-index.prepare",
    },
  );
}

function sourceSnapshotMatches(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
): boolean {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows")
      .select("transcript_updated_at")
      .where("session_id", "=", plan.sessionId),
  );
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", plan.sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return (
    session?.transcript_updated_at === plan.sourceTranscriptUpdatedAt &&
    latest?.seq === plan.sourceIndexedSeq
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
  if (!sourceSnapshotMatches(db, plan)) {
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
  if (
    current?.needs_rebuild === 0 &&
    current.indexed_seq === plan.sourceIndexedSeq &&
    !hasUnclassifiedSessionTranscriptEvents(db, plan.sessionId)
  ) {
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
  const kysely = getProjectionKysely(db);
  if (params.activeRows && params.activeRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_active_events").values(
        params.activeRows.map((row) => ({
          active_position: row.activePosition,
          context_eligible: row.contextEligible,
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
          timestamp: row.timestamp,
        })),
      ),
    );
  }
  return true;
}

/** Publishes counts and the append cursor only if the transcript snapshot stayed current. */
export function finalizePreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (
    !projectionClaimIsOwned(db, plan.sessionId, claimId) ||
    !sourceSnapshotMatches(db, plan) ||
    hasUnclassifiedSessionTranscriptEvents(db, plan.sessionId)
  ) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .updateTable("session_transcript_index_state")
      .set({
        active_event_count: plan.activeEventCount,
        active_message_count: plan.activeMessageCount,
        indexed_seq: plan.sourceIndexedSeq,
        leaf_event_id: plan.leafEventId,
        needs_rebuild: 0,
        updated_at: Date.now(),
      })
      .where("session_id", "=", plan.sessionId)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", claimId),
  );
  return true;
}
