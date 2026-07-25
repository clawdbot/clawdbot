// Removes transient runtime state from restorable OpenClaw database snapshots.
import type { DatabaseSync } from "node:sqlite";

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

/** Remove coordination rows that must never survive restore. */
export function sanitizeOpenClawStateLeaseRows(database: DatabaseSync): void {
  if (tableExists(database, "state_leases")) {
    database.prepare("DELETE FROM state_leases").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
}

/** Remove transient rows whose restoration would replay work or extend private-data retention. */
export function sanitizeOpenClawGlobalStateSnapshot(database: DatabaseSync): void {
  // Archive backup can encounter an older database shape, so each optional
  // table is detected before applying the current sanitizer contract.
  sanitizeOpenClawStateLeaseRows(database);
  if (tableExists(database, "delivery_queue_entries")) {
    database.prepare("DELETE FROM delivery_queue_entries").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
  if (tableExists(database, "plugin_blob_entries")) {
    // A TTL marks blob data as transient. Exclude every TTL row, including one
    // that is still live, so restore cannot prolong its original retention.
    database.prepare("DELETE FROM plugin_blob_entries WHERE expires_at IS NOT NULL").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
}
