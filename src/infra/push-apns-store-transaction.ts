import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;

/** Advances a registration/tombstone version without reusing an observed owner version. */
export function nextApnsRegistrationVersion(
  nodeId: string,
  previousVersions: readonly number[],
): number {
  let latest = -1;
  for (const version of previousVersions) {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`invalid APNs registration version for node ${nodeId}`);
    }
    latest = Math.max(latest, version);
  }
  if (latest === Number.MAX_SAFE_INTEGER) {
    throw new Error(`APNs registration version exhausted for node ${nodeId}`);
  }
  return Math.max(Date.now(), latest + 1);
}

/** Tombstones and deletes one APNs owner inside the caller's shared-state transaction. */
export function clearApnsRegistrationFromDatabase(
  db: OpenClawStateDatabase["db"],
  nodeId: string,
): boolean {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) {
    return false;
  }
  const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
  const currentRow = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("apns_registrations")
      .select("updated_at_ms")
      .where("node_id", "=", normalizedNodeId),
  );
  const tombstone = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("apns_registration_tombstones")
      .select("deleted_at_ms")
      .where("node_id", "=", normalizedNodeId),
  );
  const previousVersions = [currentRow?.updated_at_ms, tombstone?.deleted_at_ms].filter(
    (version): version is number => version !== undefined,
  );
  const deletedAtMs = nextApnsRegistrationVersion(normalizedNodeId, previousVersions);
  // Tombstone even an empty row so a retired source cannot restore ownership.
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("apns_registration_tombstones")
      .values({ node_id: normalizedNodeId, deleted_at_ms: deletedAtMs })
      .onConflict((conflict) =>
        conflict.column("node_id").doUpdateSet({ deleted_at_ms: deletedAtMs }),
      ),
  );
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("apns_registrations").where("node_id", "=", normalizedNodeId),
  );
  return currentRow !== undefined;
}
