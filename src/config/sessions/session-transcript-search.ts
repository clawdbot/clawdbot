// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_MESSAGE_LIMIT_MAX = 25;
const SEARCH_SESSION_LIMIT_MAX = 100;
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
  resultMode?: "messages" | "sessions";
  sessionKeys?: string[];
  storePath?: string;
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const databasePath = params.storePath
    ? resolveSqliteTargetFromSessionStorePath(params.storePath, {
        agentId: params.agentId,
      }).path
    : undefined;
  const databaseOptions = {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
    ...(databasePath ? { path: databasePath } : {}),
  };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const dirtySessions = listSessionsNeedingTranscriptIndexReconcile(database.db);
  if (dirtySessions.length > 0) {
    startSessionTranscriptIndexReconcile(databaseOptions);
  }
  const indexing =
    dirtySessions.length > 0 || isSessionTranscriptIndexReconcileRunning(databaseOptions);
  const limitMax =
    params.resultMode === "sessions" ? SEARCH_SESSION_LIMIT_MAX : SEARCH_MESSAGE_LIMIT_MAX;
  const limit = Math.min(Math.max(1, params.limit ?? 10), limitMax);
  const sessionKeys = params.sessionKeys ?? [];
  const whereSession =
    sessionKeys.length > 0
      ? ` AND session_windows.session_key IN (${sessionKeys.map(() => "?").join(", ")})`
      : "";
  // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
  // representation. session_key lives on the window row so key renames
  // never leave stale keys inside the index. Sessions flagged needs_rebuild
  // are excluded: their rows may still hold rewound-away branch text that
  // sessions_history no longer exposes, so they stay hidden until reconcile
  // rebuilds them (indexing=true tells the caller to retry).
  const messageQuery = /* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    SELECT session_windows.session_key AS session_key, session_transcript_fts.session_id AS session_id,
      message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    JOIN session_windows ON session_windows.session_id = session_transcript_fts.session_id
    WHERE session_transcript_fts MATCH ?${whereSession}
      AND session_transcript_fts.session_id NOT IN (
        SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
      )
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
  `;
  // Materialization keeps FTS5 auxiliary functions on the MATCH cursor while
  // the window ranks all messages before the outer session limit.
  const sessionQuery = /* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    WITH matched AS MATERIALIZED (
      SELECT session_windows.session_key AS session_key,
        session_transcript_fts.rowid AS fts_rowid,
        session_transcript_fts.session_id AS session_id,
        message_id, role, timestamp,
        snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
        bm25(session_transcript_fts) AS rank
      FROM session_transcript_fts
      JOIN session_windows ON session_windows.session_id = session_transcript_fts.session_id
      WHERE session_transcript_fts MATCH ?${whereSession}
        AND session_transcript_fts.session_id NOT IN (
          SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
        )
    ), ranked AS (
      SELECT matched.*,
        row_number() OVER (
          PARTITION BY session_id
          ORDER BY rank ASC, timestamp DESC, message_id ASC, fts_rowid ASC
        ) AS session_rank
      FROM matched
    )
    SELECT session_key, session_id, message_id, role, timestamp, snippet, rank
    FROM ranked
    WHERE session_rank = 1
    ORDER BY rank ASC, timestamp DESC, message_id ASC, fts_rowid ASC
    LIMIT ?
  `;
  const statement = database.db.prepare(
    params.resultMode === "sessions" ? sessionQuery : messageQuery,
  );
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
