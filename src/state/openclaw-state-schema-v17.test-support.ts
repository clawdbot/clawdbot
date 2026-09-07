import type { DatabaseSync } from "node:sqlite";

export function removePreparedWorkerOwnershipColumns(db: DatabaseSync): void {
  // Drop the constrained column first so the fixture has the actual pre-v17
  // worker shape, rather than only an older version marker.
  for (const column of [
    "preparation_consumed_at_ms",
    "preparation_expires_at_ms",
    "preparation_demand_at_ms",
    "preparation_key",
    "last_activated_at_ms",
  ]) {
    db.exec(`ALTER TABLE worker_environments DROP COLUMN ${column};`);
  }
}
