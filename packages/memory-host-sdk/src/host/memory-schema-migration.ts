// Memory Host SDK module owns temporary indexes used by legacy schema repair.
import type { DatabaseSync } from "node:sqlite";

// Same-identity values may diverge because canonical derived rows win. A row
// that cannot be represented canonically still aborts before legacy tables drop.
export function assertLegacyMemoryRowsCopied(
  db: DatabaseSync,
  query: string,
  tableName: string,
): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(
      `legacy memory ${tableName} rows could not be copied into canonical memory index rows`,
    );
  }
}

export function ensureLegacyMemoryMigrationIndexes(db: DatabaseSync, schema: string): void {
  // Shipped legacy tables index chunk ids only, while ownership repair joins by
  // path/source. These indexes disappear with the legacy tables after migration.
  db.exec(`
    CREATE INDEX IF NOT EXISTS ${schema}.memory_legacy_files_path_source_migration
      ON files(path, source);
    CREATE INDEX IF NOT EXISTS ${schema}.memory_legacy_chunks_path_source_migration
      ON chunks(path, source);
  `);
}
