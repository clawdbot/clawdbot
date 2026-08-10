import { existsSync } from "node:fs";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";

export function readExistingClawInstallSchemaVersionsSync(
  options: OpenClawStateDatabaseOptions = {},
): Map<string, ReturnType<typeof parseClawInstallRecordSchemaVersion>> {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return new Map();
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;"); // sqlite-allow-raw -- Harden one read-only runtime ownership connection.
    const hasInstallTable = db /* sqlite-allow-raw: read-only runtime ownership probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get();
    if (!hasInstallTable) {
      return new Map();
    }
    const rows =
      db /* sqlite-allow-raw: prepare one runtime ownership snapshot for configured agents. */
        .prepare("SELECT agent_id, schema_version FROM claw_installs")
        .all() as Array<{ agent_id: string; schema_version: string }>;
    return new Map(
      rows.map((row) => [row.agent_id, parseClawInstallRecordSchemaVersion(row.schema_version)]),
    );
  } finally {
    db.close();
  }
}
