import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";

const TERMINAL_ENVIRONMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_ENVIRONMENT_PRUNE_LIMIT = 256;
const TERMINAL_STATES = ["destroyed", "failed", "orphaned"] as const;

type RetentionDatabase = Pick<StateDatabase, "worker_environments" | "worker_session_placements">;

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Worker environment prune limit must be between 1 and 1000");
  }
  return value;
}

/** Deletes only old terminal environments that no placement can still resolve. */
export function pruneExpiredTerminalWorkerEnvironments(params: {
  db: DatabaseSync;
  nowMs: number;
  limit?: number;
}): number {
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error("Worker environment prune timestamp must be a non-negative safe integer");
  }
  const limit = normalizeLimit(params.limit ?? TERMINAL_ENVIRONMENT_PRUNE_LIMIT);
  const cutoffMs = Math.max(0, params.nowMs - TERMINAL_ENVIRONMENT_RETENTION_MS);
  const query = getNodeSqliteKysely<RetentionDatabase>(params.db);
  const environmentIds = executeSqliteQuerySync(
    params.db,
    query
      .selectFrom("worker_environments")
      .leftJoin(
        "worker_session_placements",
        "worker_session_placements.environment_id",
        "worker_environments.environment_id",
      )
      .select("worker_environments.environment_id")
      .where("worker_environments.state", "in", [...TERMINAL_STATES])
      .where("worker_environments.state_changed_at_ms", "<=", cutoffMs)
      .where("worker_session_placements.session_id", "is", null)
      .orderBy("worker_environments.state_changed_at_ms", "asc")
      .orderBy("worker_environments.environment_id", "asc")
      .limit(limit),
  ).rows.map((row) => row.environment_id);
  if (environmentIds.length === 0) {
    return 0;
  }
  const result = executeSqliteQuerySync(
    params.db,
    query
      .deleteFrom("worker_environments")
      .where("environment_id", "in", environmentIds)
      .where("state", "in", [...TERMINAL_STATES])
      .where("state_changed_at_ms", "<=", cutoffMs),
  );
  return Number(result.numAffectedRows ?? 0n);
}
