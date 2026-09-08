import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { decodeRun } from "./update-run-codec.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type ListInput = { limit?: number; active?: boolean };

function readRuns(db: DatabaseSync, input: ListInput): UpdateRunRecord[] {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll();
  if (input.active) {
    query = query.where("status", "=", "running");
  }
  return executeSqliteQuerySync(
    db,
    query
      .orderBy("created_at_ms", "desc")
      .orderBy("run_id", "desc")
      .limit(Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))),
  ).rows.map(decodeRun);
}

export function listUpdateRuns(
  input: ListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readRuns(db, input),
      options,
    ) ?? []
  );
}

/** Doctor awaits a private snapshot while its real maintenance owner is retained. */
export async function listUpdateRunsAsync(
  input: ListInput = {},
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRunRecord[]> {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => readRuns(db, input),
      options,
    )) ?? []
  );
}
