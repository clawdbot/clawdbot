import { existsSync } from "node:fs";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawInstallRecordFromDatabase, type PersistedClawInstall } from "./provenance.js";

export function readExistingClawInstallRecordSync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
    const hasInstallTable = db /* sqlite-allow-raw: read-only runtime ownership probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get();
    return hasInstallTable ? readClawInstallRecordFromDatabase(db, agentId) : undefined;
  } finally {
    db.close();
  }
}
