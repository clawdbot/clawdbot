import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  sqliteSessionEntryRawRowsEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

/**
 * Re-reads the rows a lifecycle target snapshot was decoded from and returns the snapshot
 * itself when every persisted row is byte-for-byte unchanged, so a commit can revalidate
 * without decoding entry JSON again. Any difference — a changed, missing, or newly present
 * row among the consulted keys — returns undefined so the caller falls back to a full
 * re-read and deep compare.
 */
export function readUnchangedLifecycleTargetSnapshot(
  database: Pick<OpenClawAgentDatabase, "db">,
  snapshot: SqliteLifecycleTargetSnapshot,
  sessionKeys: readonly string[],
): SqliteLifecycleTargetSnapshot | undefined {
  if (sessionKeys.length === 0 || snapshot.some((row) => !row.row)) {
    return undefined;
  }
  // Canonical-key validation stays with the snapshot readers: the prepared snapshot already
  // passed whatever check its reader performs, and the fallback re-read repeats it.
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "in", sessionKeys),
  ).rows;
  if (rows.length !== snapshot.length) {
    return undefined;
  }
  const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
  const unchanged = snapshot.every((prepared) => {
    const current = prepared.row ? rowsByKey.get(prepared.row.session_key) : undefined;
    return (
      prepared.row !== undefined &&
      current !== undefined &&
      sqliteSessionEntryRawRowsEqual(prepared.row, current)
    );
  });
  return unchanged ? snapshot : undefined;
}
