// Projects additive Claw provenance columns that only writable opens can ensure.
import type { DatabaseSync } from "node:sqlite";

function canSelect(db: DatabaseSync, table: string, projection: string): boolean {
  try {
    db /* sqlite-allow-raw: capability probe for lazily added Claw provenance columns. */
      .prepare(`SELECT ${projection} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only opens never run the additive column migration, so a same-version
 * database written before a column existed must still answer planning reads.
 * Absent columns project as SQL NULL, which the row parsers already treat as
 * "no recorded provenance".
 */
export function legacySafeColumnProjection(
  db: DatabaseSync,
  table: "claw_installs" | "claw_package_refs",
  columns: readonly string[],
): string {
  const full = columns.join(", ");
  if (canSelect(db, table, full)) {
    return full;
  }
  return columns
    .map((column) => (canSelect(db, table, column) ? column : `NULL AS ${column}`))
    .join(", ");
}
