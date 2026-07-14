// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and the lazy reconcile that backfills
// doctor-migrated transcripts and rebuilds branch-rewound sessions.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
  rebuildSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";

const log = createSubsystemLogger("sessions/search-index");
const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
};

const runningReconciles = new Map<string, Promise<void>>();

/**
 * Rebuilds every session whose index state lags its transcript rows, then
 * sweeps orphaned index rows. One write transaction per session keeps the
 * agent DB responsive to live appends between rebuilds.
 */
async function reconcileSessionTranscriptIndex(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const sessionIds = listSessionsNeedingTranscriptIndexReconcile(database.db);
  for (const sessionId of sessionIds) {
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        // Rows are reread inside the transaction: a live append that landed
        // after the dirty scan is either included here or re-flagged by its
        // own in-transaction hook, so the rebuild can never go stale.
        const rows = executeSqliteQuerySync(
          agentDatabase.db,
          getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "transcript_events">>(
            agentDatabase.db,
          )
            .selectFrom("transcript_events")
            .select(["seq", "event_json"])
            .where("session_id", "=", sessionId)
            .orderBy("seq", "asc"),
        ).rows;
        if (rows.length === 0) {
          return;
        }
        const events = rows.map((row) => JSON.parse(row.event_json) as unknown);
        const maxSeq = rows[rows.length - 1]?.seq ?? -1;
        rebuildSessionTranscriptIndexInTransaction(agentDatabase.db, sessionId, events, maxSeq);
      },
      { agentId: params.agentId, ...(params.env ? { env: params.env } : {}) },
      { operationLabel: "sessions.search.reconcile" },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  runOpenClawAgentWriteTransaction(
    (agentDatabase) => {
      deleteOrphanedTranscriptIndexRowsInTransaction(agentDatabase.db);
    },
    { agentId: params.agentId, ...(params.env ? { env: params.env } : {}) },
    { operationLabel: "sessions.search.orphan-sweep" },
  );
}

function startReconcile(params: { agentId: string; env?: NodeJS.ProcessEnv }): void {
  if (runningReconciles.has(params.agentId)) {
    return;
  }
  const pending = reconcileSessionTranscriptIndex(params)
    .catch((error: unknown) => {
      // The next search re-detects dirty sessions and retries.
      log.warn(
        `session transcript reconcile failed agent=${params.agentId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      runningReconciles.delete(params.agentId);
    });
  runningReconciles.set(params.agentId, pending);
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/** Search the per-agent FTS index; kicks off one background reconcile when the index lags. */
export function searchSessionTranscripts(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  sessionKeys?: string[];
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const dirtySessions = listSessionsNeedingTranscriptIndexReconcile(database.db);
  if (dirtySessions.length > 0) {
    startReconcile(params);
  }
  const indexing = dirtySessions.length > 0 || runningReconciles.has(params.agentId);
  const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
  const sessionKeys = params.sessionKeys ?? [];
  const whereSession =
    sessionKeys.length > 0
      ? ` AND sessions.session_key IN (${sessionKeys.map(() => "?").join(", ")})`
      : "";
  // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
  // representation. session_key lives on the sessions row so key renames
  // never leave stale keys inside the index. Sessions flagged needs_rebuild
  // are excluded: their rows may still hold rewound-away branch text that
  // sessions_history no longer exposes, so they stay hidden until reconcile
  // rebuilds them (indexing=true tells the caller to retry).
  const statement = database.db.prepare(/* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    SELECT sessions.session_key AS session_key, session_transcript_fts.session_id AS session_id,
      message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    JOIN sessions ON sessions.session_id = session_transcript_fts.session_id
    WHERE session_transcript_fts MATCH ?${whereSession}
      AND session_transcript_fts.session_id NOT IN (
        SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
      )
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
  `);
  const values = [toFtsQuery(query), ...sessionKeys, limit + 1];
  const rows = statement.all(...values) as Array<{
    message_id: unknown;
    rank: unknown;
    role: unknown;
    session_id: unknown;
    session_key: unknown;
    snippet: unknown;
    timestamp: unknown;
  }>;
  const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
    if (
      typeof row.session_key !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.message_id !== "string" ||
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }
    const timestamp = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
    const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
    return [
      {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        snippet:
          row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
            ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
            : row.snippet,
        score: Number.isFinite(rank) ? -rank : 0,
      },
    ];
  });
  return { hits: hits.slice(0, limit), indexing, truncated: hits.length > limit };
}
