import type { DatabaseSync } from "node:sqlite";
import { ensureWorkerEnvironmentNodeEnrollmentSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

/** Bind one environment-owned setup completion inside the pairing transaction. */
export function bindCloudWorkerSetupCompletion(params: {
  db: DatabaseSync;
  completion: { setupId: string; deviceId: string; completedAtMs: number };
}): void {
  ensureWorkerEnvironmentNodeEnrollmentSchema(params.db);
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(params.db);
  const environment = executeSqliteQueryTakeFirstSync(
    params.db,
    kysely
      .selectFrom("worker_environments")
      .select(["environment_id", "node_device_id", "updated_at_ms"])
      .where("node_setup_id", "=", params.completion.setupId),
  );
  if (!environment) {
    throw new Error("Cloud worker setup completion has no owning environment");
  }
  if (
    environment.node_device_id !== null &&
    environment.node_device_id !== params.completion.deviceId
  ) {
    throw new Error("Cloud worker setup completion identity changed");
  }
  executeSqliteQuerySync(
    params.db,
    kysely
      .updateTable("worker_environments")
      .set({
        node_device_id: params.completion.deviceId,
        updated_at_ms: Math.max(environment.updated_at_ms, params.completion.completedAtMs),
      })
      .where("environment_id", "=", environment.environment_id),
  );
}
