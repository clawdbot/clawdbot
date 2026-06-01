import path from "node:path";

/** Returns the canonical per-file SQLite partition key for cron store rows. */
export function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}
