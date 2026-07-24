import type { DatabaseSync } from "node:sqlite";
import type { Generated } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  isCanonicalSessionTranscriptEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import {
  resolveVisibleTranscriptAppendParentId,
  selectVisibleTranscriptEventEntries,
} from "./transcript-visible-events.js";

type TranscriptProjectionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "session_transcript_index_state" | "transcript_events"
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

type ProjectionDeleteChunkResult = {
  hasMore: boolean;
  owned: boolean;
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
          .selectFrom("session_windows")
          .select("transcript_updated_at")
          .where("session_id", "=", sessionId),
      );
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("transcript_events")
          .select(["event_json", "seq"])
          .where("session_id", "=", sessionId)
          .orderBy("seq", "asc"),
      ).rows;
      if (!session || rows.length === 0) {
        return undefined;
      }

      const now = Date.now();
      const events = rows.map((row) => JSON.parse(row.event_json) as unknown);
      const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
      const ftsRows: TranscriptIndexEntry[] = [];
      let activeMessageCount = 0;
      for (const entry of selectVisibleTranscriptEventEntries(events)) {
        const indexed = extractTranscriptIndexEntry(entry.event, now);
        if (indexed) {
          ftsRows.push(indexed);
        }
        const source = rows[entry.seq - 1];
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
        sessionId,
        sourceIndexedSeq: rows.at(-1)?.seq ?? -1,
        sourceTranscriptUpdatedAt: session.transcript_updated_at,
      };
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
  if (current?.needs_rebuild === 0 && current.indexed_seq === plan.sourceIndexedSeq) {
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
  return true;
}

/** Publishes counts and the append cursor only if the transcript snapshot stayed current. */
export function finalizePreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (!projectionClaimIsOwned(db, plan.sessionId, claimId) || !sourceSnapshotMatches(db, plan)) {
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
