import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export function clearTaskRegistrySqliteForTests(ownerKind: "task" | "flow"): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateDatabase>(db);
      if (ownerKind === "task") {
        executeSqliteQuerySync(db, kysely.deleteFrom("task_delivery_state"));
        executeSqliteQuerySync(db, kysely.deleteFrom("task_runs"));
      } else {
        executeSqliteQuerySync(db, kysely.deleteFrom("flow_runs"));
      }
      // Reset selected-family orphans without enabling optional lifecycle metadata.
      if (tableExists(db, "execution_owner_lifecycle_bindings")) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("execution_owner_lifecycle_bindings")
            .where("owner_kind", "=", ownerKind),
        );
      }
    });
  } catch (error) {
    const subsystem = ownerKind === "task" ? "tasks/registry" : "tasks/task-flow-registry";
    createSubsystemLogger(subsystem).warn(`Failed to reset ${ownerKind} registry storage`, {
      error,
    });
  } finally {
    closeOpenClawStateDatabase();
  }
}

export function seedTaskRegistryRowsForTests(tasks: Iterable<TaskRecord>): void {
  runOpenClawStateWriteTransaction(() => {
    for (const task of tasks) {
      upsertTaskWithDeliveryStateToSqlite({ task });
    }
  });
}
