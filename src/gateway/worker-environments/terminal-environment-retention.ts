import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
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

/** Resolve retention outside the transaction, then delete only unchanged, unreferenced rows. */
export function pruneExpiredTerminalWorkerEnvironments(params: {
  db: DatabaseSync;
  write: <T>(operation: (db: DatabaseSync) => T) => T;
  canPruneDemand: (row: Selectable<StateDatabase["worker_environments"]>) => boolean;
  nowMs: number;
  limit?: number;
}): number {
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error("Worker environment prune timestamp must be a non-negative safe integer");
  }
  const limit = normalizeLimit(params.limit ?? TERMINAL_ENVIRONMENT_PRUNE_LIMIT);
  const cutoffMs = Math.max(0, params.nowMs - TERMINAL_ENVIRONMENT_RETENTION_MS);
  const query = getNodeSqliteKysely<RetentionDatabase>(params.db);
  const eligible: Selectable<StateDatabase["worker_environments"]>[] = [];
  let cursor: { changedAtMs: number; environmentId: string } | undefined;
  // Finish each bounded read before calling policy, which may re-enter the store.
  // Advance past retained demand so it cannot starve later eligible rows.
  while (eligible.length < limit) {
    let candidateQuery = query
      .selectFrom("worker_environments")
      .leftJoin(
        "worker_session_placements",
        "worker_session_placements.environment_id",
        "worker_environments.environment_id",
      )
      .selectAll("worker_environments")
      .where("worker_environments.state", "in", [...TERMINAL_STATES])
      .where("worker_environments.state_changed_at_ms", "<=", cutoffMs)
      .where("worker_session_placements.session_id", "is", null)
      .orderBy("worker_environments.state_changed_at_ms", "asc")
      .orderBy("worker_environments.environment_id", "asc")
      .limit(TERMINAL_ENVIRONMENT_PRUNE_LIMIT);
    if (cursor) {
      const pageCursor = cursor;
      candidateQuery = candidateQuery.where((eb) =>
        eb.or([
          eb("worker_environments.state_changed_at_ms", ">", pageCursor.changedAtMs),
          eb.and([
            eb("worker_environments.state_changed_at_ms", "=", pageCursor.changedAtMs),
            eb("worker_environments.environment_id", ">", pageCursor.environmentId),
          ]),
        ]),
      );
    }
    const candidates = executeSqliteQuerySync(params.db, candidateQuery).rows;
    for (const row of candidates) {
      // Orphaned reserves still occupy capacity until physical cleanup succeeds.
      if (row.state === "orphaned" && row.preparation_key !== null) {
        continue;
      }
      if (params.canPruneDemand(row)) {
        eligible.push(row);
        if (eligible.length === limit) {
          break;
        }
      }
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < TERMINAL_ENVIRONMENT_PRUNE_LIMIT) {
      break;
    }
    cursor = { changedAtMs: last.state_changed_at_ms, environmentId: last.environment_id };
  }
  if (eligible.length === 0) {
    return 0;
  }
  return params.write((db) => {
    const currentQuery = getNodeSqliteKysely<RetentionDatabase>(db);
    let deleted = 0;
    for (const observed of eligible) {
      const current = executeSqliteQueryTakeFirstSync(
        db,
        currentQuery
          .selectFrom("worker_environments")
          .selectAll()
          .where("environment_id", "=", observed.environment_id)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("worker_session_placements")
                  .select("session_id")
                  .whereRef("environment_id", "=", "worker_environments.environment_id"),
              ),
            ),
          ),
      );
      // Policy may have re-entered the store. Revalidate every observed fact,
      // including the profile, activation and terminal age, under the write lock.
      if (isDeepStrictEqual(current, observed)) {
        const result = executeSqliteQuerySync(
          db,
          currentQuery
            .deleteFrom("worker_environments")
            .where("environment_id", "=", observed.environment_id),
        );
        deleted += Number(result.numAffectedRows ?? 0n);
      }
    }
    return deleted;
  });
}
