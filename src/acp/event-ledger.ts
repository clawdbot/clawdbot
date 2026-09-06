/** Persistent SQLite-backed ACP event ledger for session rehydration. */
import type { DatabaseSync } from "node:sqlite";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  cloneAcpLedgerValue,
  createAcpPromptUpdates,
  normalizeAcpLedgerEvent,
  normalizeAcpLedgerOptions,
  type AcpEventLedger,
  type AcpEventLedgerEntry,
  type AcpEventLedgerReplay,
  type AcpLedgerOptions,
  type AcpMutableLedgerState,
} from "./event-ledger.types.js";

export { createInMemoryAcpEventLedger } from "./event-ledger.memory.js";
export type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.types.js";

function normalizeSqliteInteger(value: number | bigint | null): number {
  return value === null ? 0 : sqliteNumber(value);
}

type AcpLedgerDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "acp_replay_sessions" | "acp_replay_events"
>;
type AcpReplayEventRow = Pick<
  AcpLedgerDatabase["acp_replay_events"],
  "session_id" | "seq" | "at" | "session_key" | "run_id" | "update_json"
>;

function sqliteRowToLedgerEvent(row: AcpReplayEventRow): AcpEventLedgerEntry | undefined {
  let update: unknown;
  try {
    update = JSON.parse(row.update_json) as unknown;
  } catch {
    return undefined;
  }
  return normalizeAcpLedgerEvent({
    seq: normalizeSqliteInteger(row.seq),
    at: normalizeSqliteInteger(row.at),
    sessionId: row.session_id,
    sessionKey: row.session_key,
    ...(row.run_id ? { runId: row.run_id } : {}),
    update,
  });
}

function sqliteSessionMetadataQuery(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpLedgerDatabase>(db)
    .selectFrom("acp_replay_sessions")
    .select(["session_id", "session_key", "cwd", "complete", "next_seq"]);
}

function readSqliteSessionById(db: DatabaseSync, sessionId: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    sqliteSessionMetadataQuery(db).where("session_id", "=", sessionId),
  );
}

function readLatestCompleteSqliteSessionByKey(db: DatabaseSync, sessionKey: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    sqliteSessionMetadataQuery(db)
      .where("session_key", "=", sessionKey)
      .where("complete", "=", 1)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
}

function upsertSqliteSession(
  db: DatabaseSync,
  state: Pick<AcpMutableLedgerState, "now">,
  params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  },
): number {
  const now = state.now();
  const existing = params.reset ? undefined : readSqliteSessionById(db, params.sessionId);
  if (existing) {
    const cwd = params.cwd || existing.cwd;
    const complete = normalizeSqliteInteger(existing.complete) === 1 || params.complete ? 1 : 0;
    // SET expressions read the pre-update row, so the aggregate sheds the old
    // key/cwd lengths and gains the new ones; drift here would silently
    // unbound the byte budget.
    db.prepare(
      `UPDATE acp_replay_sessions
          SET estimated_bytes = estimated_bytes - length(session_key) - length(cwd) + ?,
              session_key = ?, cwd = ?, complete = ?, updated_at = ?
        WHERE session_id = ?`,
    ).run(
      params.sessionKey.length + cwd.length,
      params.sessionKey,
      cwd,
      complete,
      now,
      params.sessionId,
    );
    return normalizeSqliteInteger(existing.next_seq);
  }

  if (params.reset) {
    db.prepare("DELETE FROM acp_replay_events WHERE session_id = ?").run(params.sessionId);
  }
  // A fresh or reset session's footprint is just its own row overhead; event
  // bytes accumulate onto the aggregate as appends land.
  const rowBytes = estimateSessionRowBytes({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: params.cwd,
  });
  db.prepare(
    `INSERT INTO acp_replay_sessions (
       session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       session_key = excluded.session_key,
       cwd = excluded.cwd,
       complete = excluded.complete,
       updated_at = excluded.updated_at,
       next_seq = excluded.next_seq,
       -- Row overhead plus whatever event rows still exist: exact after a
       -- reset (events deleted, sum is 0) and on any conflicting rewrite.
       estimated_bytes = excluded.estimated_bytes + COALESCE(
         (SELECT SUM(e.estimated_bytes) FROM acp_replay_events e
           WHERE e.session_id = excluded.session_id), 0)`,
  ).run(
    params.sessionId,
    params.sessionKey,
    params.cwd,
    params.complete ? 1 : 0,
    now,
    now,
    rowBytes,
  );
  return 1;
}

// Session rows carry a running footprint aggregate (row overhead plus their
// event rows), maintained at insert/trim time. The budget check therefore
// sums over at most maxSessions rows instead of scanning every event per
// append, which was O(events) per message and quadratic while trimming.
function estimateSqliteLedgerBytes(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(estimated_bytes), 0) AS total FROM acp_replay_sessions")
    .get() as { total?: number | bigint } | undefined;
  return normalizeSqliteInteger(row?.total ?? 0);
}

function estimateSessionRowBytes(params: {
  sessionId: string;
  sessionKey: string;
  cwd: string;
}): number {
  return params.sessionId.length + params.sessionKey.length + params.cwd.length + 32;
}

function estimateEventRowBytes(params: {
  sessionId: string;
  sessionKey: string;
  runId?: string;
  updateJson: string;
}): number {
  return (
    params.sessionId.length +
    params.sessionKey.length +
    params.updateJson.length +
    (params.runId?.length ?? 0) +
    32
  );
}

const LEDGER_TRIM_EVENT_BATCH = 64;

// Deletes up to `limit` oldest events for one session and returns the bytes
// released, keeping the session aggregate in sync in the same statement pair.
function deleteOldestSqliteEvents(db: DatabaseSync, sessionId: string, limit: number): number {
  const rows = db
    .prepare(
      `DELETE FROM acp_replay_events
        WHERE session_id = ?
          AND seq IN (
            SELECT seq FROM acp_replay_events
             WHERE session_id = ?
             ORDER BY seq ASC
             LIMIT ?
          )
        RETURNING estimated_bytes`,
    )
    .all(sessionId, sessionId, limit) as Array<{ estimated_bytes: number | bigint }>;
  if (rows.length === 0) {
    return 0;
  }
  const freed = rows.reduce((sum, row) => sum + normalizeSqliteInteger(row.estimated_bytes), 0);
  db.prepare(
    `UPDATE acp_replay_sessions
        SET estimated_bytes = MAX(0, estimated_bytes - ?), complete = 0
      WHERE session_id = ?`,
  ).run(freed, sessionId);
  return rows.length;
}

function trimSqliteLedger(
  db: DatabaseSync,
  state: Pick<AcpMutableLedgerState, "maxEventsPerSession" | "maxSessions" | "maxSerializedBytes">,
): void {
  // Cheap precheck: only sessions actually above the per-session cap pay for
  // event deletion (Codex log-partition pattern).
  const overCapSessions = db
    .prepare(
      `SELECT session_id, event_count FROM (
         SELECT s.session_id AS session_id, COUNT(e.seq) AS event_count
           FROM acp_replay_sessions s
           LEFT JOIN acp_replay_events e ON e.session_id = s.session_id
          GROUP BY s.session_id
       ) WHERE event_count > ?`,
    )
    .all(state.maxEventsPerSession) as Array<{ session_id: string; event_count: number | bigint }>;
  for (const row of overCapSessions) {
    const overage = normalizeSqliteInteger(row.event_count) - state.maxEventsPerSession;
    if (overage > 0) {
      deleteOldestSqliteEvents(db, row.session_id, overage);
    }
  }

  const oldSessions = db
    .prepare(
      `SELECT session_id
         FROM acp_replay_sessions
        ORDER BY updated_at DESC, session_id ASC
        LIMIT -1 OFFSET ?`,
    )
    .all(state.maxSessions) as Array<{ session_id: string }>;
  for (const session of oldSessions) {
    db.prepare("DELETE FROM acp_replay_sessions WHERE session_id = ?").run(session.session_id);
  }

  // Byte budget: evict from the least-recently-updated session in bounded
  // batches, dropping the session row itself once its events are exhausted.
  // Aggregates keep every recheck O(maxSessions); no event scans occur.
  let serializedBytes = estimateSqliteLedgerBytes(db);
  while (serializedBytes > state.maxSerializedBytes) {
    const session = db
      .prepare(
        `SELECT session_id
           FROM acp_replay_sessions
          ORDER BY updated_at ASC, session_id ASC
          LIMIT 1`,
      )
      .get() as { session_id: string } | undefined;
    if (!session) {
      break;
    }
    const deleted = deleteOldestSqliteEvents(db, session.session_id, LEDGER_TRIM_EVENT_BATCH);
    if (deleted === 0) {
      db.prepare("DELETE FROM acp_replay_sessions WHERE session_id = ?").run(session.session_id);
    }
    serializedBytes = estimateSqliteLedgerBytes(db);
  }
}

function appendSqliteUpdate(
  db: DatabaseSync,
  state: Pick<
    AcpMutableLedgerState,
    "now" | "maxEventsPerSession" | "maxSessions" | "maxSerializedBytes"
  >,
  params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  },
): void {
  const nextSeq = upsertSqliteSession(db, state, {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: "",
    complete: false,
  });
  const now = state.now();
  const updateJson = JSON.stringify(cloneAcpLedgerValue(params.update));
  const eventBytes = estimateEventRowBytes({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    updateJson,
  });
  db.prepare(
    `INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sessionId,
    nextSeq,
    now,
    params.sessionKey,
    params.runId ?? null,
    updateJson,
    eventBytes,
  );
  // The delta covers the new event plus any session-key length change; SET
  // expressions read the pre-update row, keeping the aggregate exact.
  db.prepare(
    `UPDATE acp_replay_sessions
        SET estimated_bytes = estimated_bytes - length(session_key) + ?,
            session_key = ?, updated_at = ?, next_seq = ?
      WHERE session_id = ?`,
  ).run(
    params.sessionKey.length + eventBytes,
    params.sessionKey,
    now,
    nextSeq + 1,
    params.sessionId,
  );
  trimSqliteLedger(db, state);
}

function buildSqliteReplay(
  db: DatabaseSync,
  session: ReturnType<typeof readSqliteSessionById>,
): AcpEventLedgerReplay {
  if (!session || normalizeSqliteInteger(session.complete) !== 1) {
    return { complete: false, events: [] };
  }
  // Only eligible replays load history; appends and session metadata changes
  // must not decode all prior payloads while holding the write transaction.
  const events = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<AcpLedgerDatabase>(db)
      .selectFrom("acp_replay_events")
      .select(["session_id", "seq", "at", "session_key", "run_id", "update_json"])
      .where("session_id", "=", session.session_id)
      .orderBy("seq", "asc"),
  ).rows.flatMap((row) => {
    const event = sqliteRowToLedgerEvent(row);
    return event ? [event] : [];
  });
  return {
    complete: true,
    sessionId: session.session_id,
    sessionKey: session.session_key,
    events,
  };
}

/** Creates the SQLite-backed ACP event ledger used by the state database. */
export function createSqliteAcpEventLedger(
  params: OpenClawStateDatabaseOptions & AcpLedgerOptions = {},
): AcpEventLedger {
  const normalized = normalizeAcpLedgerOptions(params);
  const dbOptions = { env: params.env, path: params.path };
  const state = {
    ...normalized,
  };
  const mutate = (fn: (db: DatabaseSync) => void) =>
    runOpenClawStateWriteTransaction((database) => fn(database.db), dbOptions);
  const read = <T>(fn: (db: DatabaseSync) => T): T => fn(openOpenClawStateDatabase(dbOptions).db);

  return {
    async startSession(sessionParams) {
      mutate((db) => {
        upsertSqliteSession(db, state, sessionParams);
        trimSqliteLedger(db, state);
      });
    },

    async recordUserPrompt(promptParams) {
      mutate((db) => {
        for (const update of createAcpPromptUpdates(promptParams.prompt)) {
          appendSqliteUpdate(db, state, {
            sessionId: promptParams.sessionId,
            sessionKey: promptParams.sessionKey,
            runId: promptParams.runId,
            update,
          });
        }
      });
    },

    async recordUpdate(updateParams) {
      mutate((db) => {
        appendSqliteUpdate(db, state, updateParams);
      });
    },

    async markIncomplete(markParams) {
      mutate((db) => {
        db.prepare(
          `UPDATE acp_replay_sessions
              SET complete = 0, updated_at = ?
            WHERE session_id = ? AND session_key = ?`,
        ).run(state.now(), markParams.sessionId, markParams.sessionKey);
      });
    },

    async readReplay(replayParams) {
      return read((db) => {
        const session = readSqliteSessionById(db, replayParams.sessionId);
        if (session?.session_key !== replayParams.sessionKey) {
          return { complete: false, events: [] };
        }
        return buildSqliteReplay(db, session);
      });
    },

    async readReplayBySessionId(replayParams) {
      return read((db) => buildSqliteReplay(db, readSqliteSessionById(db, replayParams.sessionId)));
    },

    async readReplayBySessionKey(replayParams) {
      return read((db) =>
        buildSqliteReplay(db, readLatestCompleteSqliteSessionByKey(db, replayParams.sessionKey)),
      );
    },
  };
}
