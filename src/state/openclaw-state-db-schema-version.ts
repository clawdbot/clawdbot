import type { DatabaseSync } from "node:sqlite";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

// Read-only clients need schema admission without loading updater publication policy.
export const CONTENT_VERSION_KEY = "state.schema.contentVersion";
type StateSchemaVersionDatabase = Pick<DB, "config_machine_state">;
// Admission also runs on cached reads. Retain the SQL, never the content version.
const contentVersionQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<void, Pick<DB["config_machine_state"], "value_json">>>
>();

/** Content and its marker commit together, even while older readers retain their version floor. */
export function readStateSchemaContentVersion(db: DatabaseSync): number {
  const published = readSqliteUserVersion(db);
  if (!tableExists(db, "config_machine_state")) {
    return published;
  }
  let query = contentVersionQueries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync(db, () =>
      getNodeSqliteKysely<StateSchemaVersionDatabase>(db)
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", CONTENT_VERSION_KEY),
    );
    contentVersionQueries.set(db, query);
  }
  const row = query().rows[0];
  if (!row) {
    return published;
  }
  const contentVersion: unknown = JSON.parse(row.value_json);
  if (
    typeof contentVersion !== "number" ||
    !Number.isSafeInteger(contentVersion) ||
    contentVersion < 0
  ) {
    throw new Error(`Invalid shared state schema content version in ${CONTENT_VERSION_KEY}.`);
  }
  return Math.max(published, contentVersion);
}

export function assertSupportedStateSchemaVersion(db: DatabaseSync, pathname: string): number {
  const userVersion = readSqliteUserVersion(db);
  const contentVersion =
    userVersion > OPENCLAW_STATE_SCHEMA_VERSION ? userVersion : readStateSchemaContentVersion(db);
  if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      pathname,
      contentVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
  return userVersion;
}
