/** Persistent SQLite-backed ACP event ledger for session rehydration. */
import type { DatabaseSync } from "node:sqlite";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
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
import { estimateAcpEventRowBytes, estimateAcpSessionRowBytes } from "./event-ledger-bytes.js";
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

type AcpReplaySessionRow = Pick<
  AcpLedgerDatabase["acp_replay_sessions"],
  "session_id" | "session_key" | "cwd" | "complete" | "next_seq"
>;

function createSqliteLedgerQueries(db: DatabaseSync) {
  const query = getNodeSqliteKysely<AcpLedgerDatabase>(db);
  return {
    readSession: prepareSqliteQuerySync<string, AcpReplaySessionRow>(db, (parameter) =>
      sqliteSessionMetadataQuery(db).where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
    ),
    updateSessionMetadata: prepareSqliteQuerySync<{
      sessionId: string;
      sessionKey: string;
      cwd: string;
      complete: number;
      now: number;
      metadataDelta: number;
    }>(db, (parameter) =>
      query
        .updateTable("acp_replay_sessions")
        .set((eb) => ({
          estimated_bytes: eb(
            "estimated_bytes",
            "+",
            parameter((params) => params.metadataDelta),
          ),
          session_key: parameter((params) => params.sessionKey),
          cwd: parameter((params) => params.cwd),
          complete: parameter((params) => params.complete),
          updated_at: parameter((params) => params.now),
        }))
        .where(
          "session_id",
          "=",
          parameter((params) => params.sessionId),
        ),
    ),
    insertEvent: prepareSqliteQuerySync<{
      sessionId: string;
      seq: number;
      at: number;
      sessionKey: string;
      runId: string | null;
      updateJson: string;
      eventBytes: number;
    }>(db, (parameter) =>
      query.insertInto("acp_replay_events").values({
        session_id: parameter((params) => params.sessionId),
        seq: parameter((params) => params.seq),
        at: parameter((params) => params.at),
        session_key: parameter((params) => params.sessionKey),
        run_id: parameter((params) => params.runId),
        update_json: parameter((params) => params.updateJson),
        estimated_bytes: parameter((params) => params.eventBytes),
      }),
    ),
    updateSessionAfterAppend: prepareSqliteQuerySync<{
      sessionId: string;
      eventBytes: number;
      now: number;
      nextSeq: number;
    }>(db, (parameter) =>
      query
        .updateTable("acp_replay_sessions")
        .set((eb) => ({
          estimated_bytes: eb(
            "estimated_bytes",
            "+",
            parameter((params) => params.eventBytes),
          ),
          updated_at: parameter((params) => params.now),
          next_seq: parameter((params) => params.nextSeq),
        }))
        .where(
          "session_id",
          "=",
          parameter((params) => params.sessionId),
        ),
    ),
    readOverCapSessions: prepareSqliteQuerySync<
      number,
      { session_id: string; event_count: number }
    >(db, (parameter) =>
      query
        .selectFrom(
          query
            .selectFrom("acp_replay_sessions as s")
            .leftJoin("acp_replay_events as e", "e.session_id", "s.session_id")
            .select("s.session_id")
            .select((eb) => eb.fn.count<number>("e.seq").as("event_count"))
            .groupBy("s.session_id")
            .as("counts"),
        )
        .select(["session_id", "event_count"])
        .where(
          "event_count",
          ">",
          parameter((limit) => limit),
        ),
    ),
    readExcessSessions: prepareSqliteQuerySync<number, { session_id: string }>(db, (parameter) =>
      query
        .selectFrom("acp_replay_sessions")
        .select("session_id")
        .orderBy("updated_at", "desc")
        .orderBy("session_id", "asc")
        .limit(-1)
        .offset(parameter((limit) => limit)),
    ),
    readTotalBytes: prepareSqliteQuerySync<void, { total: number }>(db, () =>
      query
        .selectFrom("acp_replay_sessions")
        .select((eb) =>
          eb.fn.coalesce(eb.fn.sum<number>("estimated_bytes"), eb.val(0)).as("total"),
        ),
    ),
    readOldestSession: prepareSqliteQuerySync<void, { session_id: string }>(db, () =>
      query
        .selectFrom("acp_replay_sessions")
        .select("session_id")
        .orderBy("updated_at", "asc")
        .orderBy("session_id", "asc")
        .limit(1),
    ),
    deleteOldestEvents: prepareSqliteQuerySync<
      { sessionId: string; limit: number },
      { estimated_bytes: number }
    >(db, (parameter) => {
      const sessionId = parameter((params) => params.sessionId);
      return query
        .deleteFrom("acp_replay_events")
        .where("session_id", "=", sessionId)
        .where(
          "seq",
          "in",
          query
            .selectFrom("acp_replay_events")
            .select("seq")
            .where("session_id", "=", sessionId)
            .orderBy("seq", "asc")
            .limit(parameter((params) => params.limit)),
        )
        .returning("estimated_bytes");
    }),
    subtractSessionBytes: prepareSqliteQuerySync<{ sessionId: string; freed: number }>(
      db,
      (parameter) =>
        query
          .updateTable("acp_replay_sessions")
          .set((eb) => ({
            estimated_bytes: eb.fn<number>("max", [
              eb.val(0),
              eb(
                "estimated_bytes",
                "-",
                parameter((params) => params.freed),
              ),
            ]),
            complete: 0,
          }))
          .where(
            "session_id",
            "=",
            parameter((params) => params.sessionId),
          ),
    ),
    deleteSession: prepareSqliteQuerySync<string>(db, (parameter) =>
      query.deleteFrom("acp_replay_sessions").where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
    ),
  };
}

const sqliteLedgerQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof createSqliteLedgerQueries>
>();

function getSqliteLedgerQueries(db: DatabaseSync) {
  let queries = sqliteLedgerQueries.get(db);
  if (!queries) {
    // Retain compilation per physical connection; native statements and their
    // invalidation remain owned by the bounded shared executor cache.
    queries = createSqliteLedgerQueries(db);
    sqliteLedgerQueries.set(db, queries);
  }
  return queries;
}

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
  return getSqliteLedgerQueries(db).readSession(sessionId).rows[0];
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
    const metadataDelta =
      estimateAcpSessionRowBytes({ ...params, cwd }) -
      estimateAcpSessionRowBytes({
        sessionId: params.sessionId,
        sessionKey: existing.session_key,
        cwd: existing.cwd,
      });
    getSqliteLedgerQueries(db).updateSessionMetadata({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cwd,
      complete,
      now,
      metadataDelta,
    });
    return normalizeSqliteInteger(existing.next_seq);
  }

  if (params.reset) {
    db.prepare("DELETE FROM acp_replay_events WHERE session_id = ?").run(params.sessionId);
  }
  // A fresh or reset session's footprint is just its own row overhead; event
  // bytes accumulate onto the aggregate as appends land.
  const rowBytes = estimateAcpSessionRowBytes({
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
  const row = getSqliteLedgerQueries(db).readTotalBytes().rows[0];
  return normalizeSqliteInteger(row?.total ?? 0);
}

const LEDGER_TRIM_EVENT_BATCH = 64;

// Deletes up to `limit` oldest events for one session and returns the bytes
// released, keeping the session aggregate in sync in the same statement pair.
function deleteOldestSqliteEvents(db: DatabaseSync, sessionId: string, limit: number): number {
  const queries = getSqliteLedgerQueries(db);
  const rows = queries.deleteOldestEvents({ sessionId, limit }).rows;
  if (rows.length === 0) {
    return 0;
  }
  const freed = rows.reduce((sum, row) => sum + normalizeSqliteInteger(row.estimated_bytes), 0);
  queries.subtractSessionBytes({ sessionId, freed });
  return rows.length;
}

function trimSqliteLedger(
  db: DatabaseSync,
  state: Pick<AcpMutableLedgerState, "maxEventsPerSession" | "maxSessions" | "maxSerializedBytes">,
): void {
  // Cheap precheck: only sessions actually above the per-session cap pay for
  // event deletion (Codex log-partition pattern).
  const queries = getSqliteLedgerQueries(db);
  const overCapSessions = queries.readOverCapSessions(state.maxEventsPerSession).rows;
  for (const row of overCapSessions) {
    const overage = normalizeSqliteInteger(row.event_count) - state.maxEventsPerSession;
    if (overage > 0) {
      deleteOldestSqliteEvents(db, row.session_id, overage);
    }
  }

  const oldSessions = queries.readExcessSessions(state.maxSessions).rows;
  for (const session of oldSessions) {
    queries.deleteSession(session.session_id);
  }

  // Byte budget: evict from the least-recently-updated session in bounded
  // batches, dropping the session row itself once its events are exhausted.
  // Aggregates keep every recheck O(maxSessions); no event scans occur.
  let serializedBytes = estimateSqliteLedgerBytes(db);
  while (serializedBytes > state.maxSerializedBytes) {
    const session = queries.readOldestSession().rows[0];
    if (!session) {
      break;
    }
    const deleted = deleteOldestSqliteEvents(db, session.session_id, LEDGER_TRIM_EVENT_BATCH);
    if (deleted === 0) {
      queries.deleteSession(session.session_id);
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
  const eventBytes = estimateAcpEventRowBytes({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    updateJson,
  });
  const queries = getSqliteLedgerQueries(db);
  queries.insertEvent({
    sessionId: params.sessionId,
    seq: nextSeq,
    at: now,
    sessionKey: params.sessionKey,
    runId: params.runId ?? null,
    updateJson,
    eventBytes,
  });
  // Upsert already accounted for metadata; only the new event remains.
  queries.updateSessionAfterAppend({
    sessionId: params.sessionId,
    eventBytes,
    now,
    nextSeq: nextSeq + 1,
  });
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
