// SQLite trajectory runtime store owns session-scoped runtime event rows.

import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "./paths.js";
import type { TrajectoryEvent } from "./types.js";

type SqliteTrajectoryRuntimeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "trajectory_runtime_events"
>;

const TRAJECTORY_RUNTIME_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const TRAJECTORY_RUNTIME_GLOBAL_MAX_BYTES = 512 * 1024 * 1024;
const TRAJECTORY_RUNTIME_GLOBAL_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const TRAJECTORY_RUNTIME_DELETE_RUN_BATCH_SIZE = 100;

export type SqliteTrajectoryRuntimeScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  maxGlobalRuntimeBytes?: number;
  maxRuntimeBytes?: number;
  sessionId: string;
  storePath: string;
};

type SqliteTrajectoryRuntimeReadScope = Omit<
  SqliteTrajectoryRuntimeScope,
  "maxGlobalRuntimeBytes" | "maxRuntimeBytes"
>;

type SqliteTrajectoryRuntimeEventRow = {
  event: TrajectoryEvent;
  seq: number;
};

type TrajectoryRuntimeRow = {
  event_json: string;
  seq: number;
};

type TrajectoryRuntimeRun = {
  newestCreatedAt: number;
  runId: string | null;
  runtimeBytes: number;
  sessionId: string;
};

// The runtime store owns this process-local cadence. Database handles are cached,
// so a WeakMap rate-limits work without retaining closed agent databases.
const lastGlobalSweepAtByDatabase = new WeakMap<OpenClawAgentDatabase, number>();

/** Appends runtime trajectory events to the per-agent SQLite session store. */
export function appendSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeScope,
  events: readonly TrajectoryEvent[],
): void {
  if (events.length === 0) {
    return;
  }
  const options = toDatabaseOptions(scope);
  const maxRuntimeBytes = Math.max(
    1,
    Math.floor(scope.maxRuntimeBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  const maxGlobalRuntimeBytes = Math.max(
    1,
    Math.floor(scope.maxGlobalRuntimeBytes ?? TRAJECTORY_RUNTIME_GLOBAL_MAX_BYTES),
  );
  const sweepAt = Date.now();
  let sweptDatabase: OpenClawAgentDatabase | undefined;
  runOpenClawAgentWriteTransaction((database) => {
    const db = getTrajectoryKysely(database.db);
    let seq = readNextTrajectorySeq(database, scope.sessionId);
    for (const event of events) {
      const eventJson = JSON.stringify(event);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("trajectory_runtime_events").values({
          session_id: scope.sessionId,
          seq,
          run_id: event.runId ?? null,
          event_json: eventJson,
          created_at: readTrajectoryEventTimestamp(event) ?? Date.now(),
        }),
      );
      seq += 1;
    }
    trimSqliteTrajectoryRuntimeWindow(database, scope.sessionId, maxRuntimeBytes);
    const lastSweptAt = lastGlobalSweepAtByDatabase.get(database);
    if (
      lastSweptAt === undefined ||
      sweepAt < lastSweptAt ||
      sweepAt - lastSweptAt >= TRAJECTORY_RUNTIME_GLOBAL_SWEEP_INTERVAL_MS
    ) {
      sweepSqliteTrajectoryRuntimeRetention(
        database,
        scope.sessionId,
        sweepAt,
        maxGlobalRuntimeBytes,
      );
      sweptDatabase = database;
    }
  }, options);
  if (sweptDatabase) {
    lastGlobalSweepAtByDatabase.set(sweptDatabase, sweepAt);
  }
}

/** Loads runtime trajectory events from per-agent SQLite rows in storage order. */
export async function loadSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeReadScope,
): Promise<TrajectoryEvent[]> {
  return loadSqliteTrajectoryRuntimeEventsSync(scope);
}

/** Loads runtime trajectory events synchronously for CLI and export paths. */
function loadSqliteTrajectoryRuntimeEventsSync(
  scope: SqliteTrajectoryRuntimeReadScope,
): TrajectoryEvent[] {
  return loadSqliteTrajectoryRuntimeEventRowsSync(scope).map((row) => row.event);
}

/** Loads runtime trajectory event rows with storage seqs for follow/export cursors. */
export function loadSqliteTrajectoryRuntimeEventRowsSync(
  scope: SqliteTrajectoryRuntimeReadScope & {
    afterSeq?: number;
    maxEvents?: number;
    tailEvents?: number;
  },
): SqliteTrajectoryRuntimeEventRow[] {
  const read = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getTrajectoryKysely(database.db);
    const tailEvents =
      scope.tailEvents !== undefined && Number.isFinite(scope.tailEvents)
        ? Math.max(0, Math.floor(scope.tailEvents))
        : undefined;
    let query = db
      .selectFrom("trajectory_runtime_events")
      .select(["seq", "event_json"])
      .where("session_id", "=", scope.sessionId)
      .orderBy("seq", tailEvents === undefined ? "asc" : "desc");
    const afterSeq = scope.afterSeq;
    if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
      query = query.where("seq", ">", Math.floor(afterSeq));
    }
    const normalizedMaxEvents =
      scope.maxEvents !== undefined && Number.isFinite(scope.maxEvents)
        ? Math.max(0, Math.floor(scope.maxEvents))
        : undefined;
    const maxEvents =
      tailEvents === undefined
        ? normalizedMaxEvents
        : normalizedMaxEvents === undefined
          ? tailEvents
          : Math.min(tailEvents, normalizedMaxEvents);
    if (maxEvents !== undefined && Number.isFinite(maxEvents)) {
      query = query.limit(Math.max(0, Math.floor(maxEvents)));
    }
    const rows = executeSqliteQuerySync(database.db, query).rows.map((row) => ({
      event: JSON.parse(row.event_json) as TrajectoryEvent,
      seq: row.seq,
    }));
    return tailEvents === undefined ? rows : rows.toReversed();
  }, toDatabaseOptions(scope));
  return read.found ? read.value : [];
}

function sweepSqliteTrajectoryRuntimeRetention(
  database: OpenClawAgentDatabase,
  currentSessionId: string,
  now: number,
  maxGlobalRuntimeBytes: number,
): void {
  const runs = readSqliteTrajectoryRuntimeRuns(database);
  let retainedBytes = runs.reduce((total, run) => total + run.runtimeBytes, 0);
  const cutoff = now - TRAJECTORY_RUNTIME_RETENTION_MAX_AGE_MS;
  const deletedRuns = new Set<TrajectoryRuntimeRun>();
  for (const run of runs) {
    if (run.sessionId !== currentSessionId && run.newestCreatedAt < cutoff) {
      deletedRuns.add(run);
      retainedBytes -= run.runtimeBytes;
    }
  }
  for (const run of runs.toSorted(compareTrajectoryRuntimeRunsOldestFirst)) {
    if (retainedBytes <= maxGlobalRuntimeBytes) {
      break;
    }
    // The per-session trim already bounds the active writer. Preserve its just-written
    // events while the global budget evicts complete older runs elsewhere.
    if (run.sessionId === currentSessionId || deletedRuns.has(run)) {
      continue;
    }
    deletedRuns.add(run);
    retainedBytes -= run.runtimeBytes;
  }
  deleteSqliteTrajectoryRuntimeRuns(database, [...deletedRuns]);
}

function readSqliteTrajectoryRuntimeRuns(database: OpenClawAgentDatabase): TrajectoryRuntimeRun[] {
  const db = getTrajectoryKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id", "run_id"])
      .select((eb) => [
        eb.fn.max<number | bigint>("created_at").as("newest_created_at"),
        eb.fn
          .sum<number | bigint>(eb(eb.fn<number>("octet_length", ["event_json"]), "+", 1))
          .as("runtime_bytes"),
      ])
      .groupBy(["session_id", "run_id"]),
  ).rows;
  return rows.map((row) => ({
    newestCreatedAt: sqliteNumber(row.newest_created_at),
    runId: row.run_id,
    runtimeBytes: sqliteNumber(row.runtime_bytes),
    sessionId: row.session_id,
  }));
}

function deleteSqliteTrajectoryRuntimeRuns(
  database: OpenClawAgentDatabase,
  runs: readonly TrajectoryRuntimeRun[],
): void {
  const db = getTrajectoryKysely(database.db);
  for (let index = 0; index < runs.length; index += TRAJECTORY_RUNTIME_DELETE_RUN_BATCH_SIZE) {
    const batch = runs.slice(index, index + TRAJECTORY_RUNTIME_DELETE_RUN_BATCH_SIZE);
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("trajectory_runtime_events")
        .where((eb) =>
          eb.or(
            batch.map((run) =>
              eb.and([
                eb("session_id", "=", run.sessionId),
                run.runId === null ? eb("run_id", "is", null) : eb("run_id", "=", run.runId),
              ]),
            ),
          ),
        ),
    );
  }
}

function compareTrajectoryRuntimeRunsOldestFirst(
  left: TrajectoryRuntimeRun,
  right: TrajectoryRuntimeRun,
): number {
  return (
    left.newestCreatedAt - right.newestCreatedAt ||
    left.sessionId.localeCompare(right.sessionId) ||
    (left.runId ?? "").localeCompare(right.runId ?? "")
  );
}

function getTrajectoryKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SqliteTrajectoryRuntimeDatabase>(database);
}

function toDatabaseOptions(scope: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
}): OpenClawAgentDatabaseOptions {
  const requestedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : undefined;
  const target = resolveSqliteTargetFromSessionStorePath(
    scope.storePath,
    requestedAgentId ? { agentId: requestedAgentId } : {},
  );
  if (requestedAgentId && target.agentId && requestedAgentId !== target.agentId) {
    throw new Error(
      `SQLite trajectory store path belongs to agent ${target.agentId}; requested agent ${requestedAgentId}.`,
    );
  }
  const agentId = requestedAgentId ?? target.agentId;
  if (!agentId) {
    throw new Error("Trajectory store scope requires an explicit agent id.");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(target.path ? { path: target.path } : {}),
  };
}

function readNextTrajectorySeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const db = getTrajectoryKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  );
  if (row?.max_seq === null || row?.max_seq === undefined) {
    return 0;
  }
  return sqliteNumber(row.max_seq) + 1;
}

function trimSqliteTrajectoryRuntimeWindow(
  database: OpenClawAgentDatabase,
  sessionId: string,
  maxRuntimeBytes: number,
): void {
  const db = getTrajectoryKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["seq", "event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  const removableSeqs = oldestTrajectorySeqsPastByteWindow(rows, maxRuntimeBytes);
  if (removableSeqs.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("trajectory_runtime_events")
      .where("session_id", "=", sessionId)
      .where("seq", "in", removableSeqs),
  );
}

function oldestTrajectorySeqsPastByteWindow(
  rows: readonly TrajectoryRuntimeRow[],
  maxRuntimeBytes: number,
): number[] {
  let totalBytes = rows.reduce((total, row) => total + trajectoryJsonlRowBytes(row.event_json), 0);
  const removableSeqs: number[] = [];
  for (const row of rows) {
    if (totalBytes <= maxRuntimeBytes) {
      break;
    }
    removableSeqs.push(row.seq);
    totalBytes -= trajectoryJsonlRowBytes(row.event_json);
  }
  return removableSeqs;
}

function trajectoryJsonlRowBytes(eventJson: string): number {
  return Buffer.byteLength(eventJson, "utf8") + 1;
}

function readTrajectoryEventTimestamp(event: TrajectoryEvent): number | undefined {
  return parseDateStringTimestampMs(event.ts);
}
