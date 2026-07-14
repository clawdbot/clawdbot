// SQLite trajectory runtime store owns session-scoped runtime event rows.

import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
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

export type SqliteTrajectoryRuntimeScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  maxRuntimeBytes?: number;
  sessionId: string;
  storePath: string;
};

type SqliteTrajectoryRuntimeEventRow = {
  event: TrajectoryEvent;
  seq: number;
};

type TrajectoryRuntimeRow = {
  event_json: string;
  seq: number;
};

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
  }, options);
}

/** Loads runtime trajectory events from per-agent SQLite rows in storage order. */
export async function loadSqliteTrajectoryRuntimeEvents(
  scope: Omit<SqliteTrajectoryRuntimeScope, "maxRuntimeBytes">,
): Promise<TrajectoryEvent[]> {
  return loadSqliteTrajectoryRuntimeEventsSync(scope);
}

/** Loads runtime trajectory events synchronously for CLI and export paths. */
function loadSqliteTrajectoryRuntimeEventsSync(
  scope: Omit<SqliteTrajectoryRuntimeScope, "maxRuntimeBytes">,
): TrajectoryEvent[] {
  return loadSqliteTrajectoryRuntimeEventRowsSync(scope).map((row) => row.event);
}

/** Loads runtime trajectory event rows with storage seqs for follow/export cursors. */
export function loadSqliteTrajectoryRuntimeEventRowsSync(
  scope: Omit<SqliteTrajectoryRuntimeScope, "maxRuntimeBytes"> & {
    afterSeq?: number;
    maxEvents?: number;
  },
): SqliteTrajectoryRuntimeEventRow[] {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
  const db = getTrajectoryKysely(database.db);
  let query = db
    .selectFrom("trajectory_runtime_events")
    .select(["seq", "event_json"])
    .where("session_id", "=", scope.sessionId)
    .orderBy("seq", "asc");
  const afterSeq = scope.afterSeq;
  if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
    query = query.where("seq", ">", Math.floor(afterSeq));
  }
  const maxEvents = scope.maxEvents;
  if (maxEvents !== undefined && Number.isFinite(maxEvents)) {
    query = query.limit(Math.max(0, Math.floor(maxEvents)));
  }
  return executeSqliteQuerySync(database.db, query).rows.map((row) => ({
    event: JSON.parse(row.event_json) as TrajectoryEvent,
    seq: row.seq,
  }));
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
  return {
    agentId: requestedAgentId ?? target.agentId ?? DEFAULT_AGENT_ID,
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
  return normalizeSqliteNumber(row.max_seq) + 1;
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
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}
