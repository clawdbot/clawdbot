import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  classifyExecutionOwnerBinding,
  type ExecutionOwnerBindingResult,
} from "./execution-owner-binding.js";

export const EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE =
  "execution_owner_lifecycle_bindings" as const;
type ExecutionOwnerLifecycleKind = "cron" | "task" | "flow";

type ExecutionOwnerLifecycleDatabase = Pick<
  OpenClawStateDatabase,
  "cron_run_receipts" | "execution_owner_lifecycle_bindings" | "flow_runs" | "task_runs"
>;

const SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE} (`;
const SCHEMA_END = ") STRICT;";

function lifecycleDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ExecutionOwnerLifecycleDatabase>(db);
}

/** Creates only the canonical additive metadata table at first admitted owner use. */
function ensureExecutionOwnerLifecycleBindingSchema(db: DatabaseSync): void {
  if (tableExists(db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)) {
    return;
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = start < 0 ? -1 : OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end < start) {
    throw new Error("OpenClaw execution owner lifecycle binding schema marker is missing.");
  }
  // sqlite-allow-raw -- Canonical feature-local additive DDL only; metadata rows use Kysely.
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + SCHEMA_END.length));
}

function classifyRetainedBinding(
  current: { context_id: string; execution_id: string },
  binding: { contextId: string; executionId: string },
): "already-bound" | "mismatch" {
  const state = classifyExecutionOwnerBinding(
    { contextId: current.context_id, executionId: current.execution_id },
    binding,
  );
  return state === "unbound" ? "mismatch" : state;
}

/** Stores one exact admission identity after its canonical owner row has been revalidated. */
export function bindExecutionOwnerLifecycleMetadata(params: {
  db: DatabaseSync;
  ownerKind: ExecutionOwnerLifecycleKind;
  ownerId: string;
  binding: { contextId: string; executionId: string };
}): Exclude<ExecutionOwnerBindingResult, "disabled" | "missing"> {
  ensureExecutionOwnerLifecycleBindingSchema(params.db);
  const database = lifecycleDb(params.db);
  const current = executeSqliteQueryTakeFirstSync(
    params.db,
    database
      .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .select(["context_id", "execution_id"])
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "=", params.ownerId),
  );
  if (current) {
    return classifyRetainedBinding(current, params.binding);
  }
  const inserted = executeSqliteQuerySync(
    params.db,
    database
      .insertInto(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .values({
        owner_kind: params.ownerKind,
        owner_id: params.ownerId,
        context_id: params.binding.contextId,
        execution_id: params.binding.executionId,
      })
      .onConflict((conflict) => conflict.columns(["owner_kind", "owner_id"]).doNothing()),
  );
  if (Number(inserted.numAffectedRows ?? 0n) === 1) {
    return "bound";
  }
  const raced = executeSqliteQueryTakeFirstSync(
    params.db,
    database
      .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .select(["context_id", "execution_id"])
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "=", params.ownerId),
  );
  return raced ? classifyRetainedBinding(raced, params.binding) : "mismatch";
}

/** Removes exact owner metadata without allocating the opt-in table. */
export function deleteExecutionOwnerLifecycleMetadata(params: {
  db: DatabaseSync;
  ownerKind: ExecutionOwnerLifecycleKind;
  ownerIds: readonly string[];
}): void {
  if (
    params.ownerIds.length === 0 ||
    !tableExists(params.db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
  ) {
    return;
  }
  executeSqliteQuerySync(
    params.db,
    lifecycleDb(params.db)
      .deleteFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "in", params.ownerIds),
  );
}

/** Removes bindings whose canonical owner row was pruned in the same transaction. */
export function pruneOrphanedExecutionOwnerLifecycleMetadata(
  db: DatabaseSync,
  ownerKind: ExecutionOwnerLifecycleKind,
): void {
  if (!tableExists(db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)) {
    return;
  }
  const database = lifecycleDb(db);
  const bindings = database
    .deleteFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
    .where("owner_kind", "=", ownerKind);
  if (ownerKind === "cron") {
    executeSqliteQuerySync(
      db,
      bindings.where(
        "owner_id",
        "not in",
        database.selectFrom("cron_run_receipts").select("receipt_id"),
      ),
    );
  } else if (ownerKind === "task") {
    executeSqliteQuerySync(
      db,
      bindings.where("owner_id", "not in", database.selectFrom("task_runs").select("task_id")),
    );
  } else {
    executeSqliteQuerySync(
      db,
      bindings.where("owner_id", "not in", database.selectFrom("flow_runs").select("flow_id")),
    );
  }
}
