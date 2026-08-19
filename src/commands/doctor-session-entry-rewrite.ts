import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { parseSqliteSessionEntryRecord } from "../config/sessions/session-entry-json.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";

export type DoctorSessionEntryRow = {
  current_session_id: string;
  entry_json: string;
  session_key: string;
  updated_at: number;
};

/** Persist a doctor-proven entry rewrite and settle the schema-owned validity projection. */
export function writeValidatedDoctorSessionEntryJson(
  database: OpenClawAgentDatabase,
  row: DoctorSessionEntryRow,
  entryJson: string,
): void {
  if (!parseSqliteSessionEntryRecord({ ...row, entry_json: entryJson })) {
    throw new Error(`Refusing invalid SQLite session entry rewrite for ${row.session_key}`);
  }
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  const writeGeneration = trackSessionEntryCacheWrite(database, () => {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_json: entryJson })
        .where("session_key", "=", row.session_key),
    );
    // The entry_json trigger marks every rewrite pending, including a value already validated
    // above. Settle it separately so the next strict reader does not reject doctor's output.
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_valid: 1 })
        .where("session_key", "=", row.session_key),
    );
  });
  // The transaction owner defers this row publication until commit; rollback must never
  // expose repaired JSON through a warm connection-local session cache.
  publishSessionEntryCacheInvalidation(
    database,
    { ...row, entry_json: entryJson },
    writeGeneration,
  );
}
