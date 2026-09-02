import type { DatabaseSync } from "node:sqlite";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { hasLegacyCronRunLogs } from "../infra/state-migrations.cron-run-logs.js";
import { VERSION } from "../version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  assertSupportedSchemaVersion,
} from "./openclaw-state-db-maintenance.js";
import { assertCanonicalStateSchemaShape } from "./openclaw-state-db-schema-repair.js";
import {
  getOpenClawStateRuntimeSchema,
  isOpenClawStateStartupRepairableSchemaIssue,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

export function assertCurrentStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  readTable?: SqliteTableContractReader,
): void {
  assertCanonicalStateSchemaShape(database, pathname);
  assertOpenClawStateDatabaseForMaintenance(database, { pathname }, readTable);
}

export function isOpenClawStateSchemaFastPathEligible(
  database: DatabaseSync,
  pathname: string,
): boolean {
  return runSqliteDeferredTransactionSync(database, () => {
    assertSupportedSchemaVersion(database, pathname);
    if (readSqliteUserVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      return false;
    }
    assertSqliteIntegrity(database, pathname);
    // Both policies see this read transaction; repair must collect fresh facts after it ends.
    const readTable = createSqliteTableContractReader(database);
    assertCurrentStateRuntimeSchema(database, pathname, readTable);
    const startupRepairRequired = collectSqliteSchemaIssues(
      database,
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
      readTable,
    ).some(isOpenClawStateStartupRepairableSchemaIssue);
    if (startupRepairRequired) {
      return false;
    }
    if (hasLegacyCronRunLogs(database)) {
      return false;
    }
    // app_version commits only after this release's repairs; same-build writes are canonical.
    const metadata = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
      .get();
    return metadata?.app_version === VERSION;
  });
}
