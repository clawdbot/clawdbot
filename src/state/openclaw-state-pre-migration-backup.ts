import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type PreMigrationBackupResult =
  | { status: "created"; backupPath: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** Directory (relative to the state database) that holds pre-migration copies. */
export const PRE_MIGRATION_BACKUP_DIRNAME = "pre-migration-backups";

/**
 * Create a consistent, best-effort copy of the shared state database before a
 * forward schema migration bumps its on-disk version.
 *
 * OpenClaw migrates the state schema in place on startup. Once the on-disk
 * `user_version` is raised, an older build refuses to open the database
 * ("uses newer schema version N; this OpenClaw build supports M"), so an
 * interrupted, unwanted, or buggy upgrade has no recovery path unless a copy was
 * taken first. `VACUUM INTO` writes a single consistent snapshot (including
 * committed WAL frames) without holding a write transaction, so it is safe to
 * call on the live handle before the migration transaction begins.
 *
 * This is best effort: a backup failure is reported to the caller (which surfaces
 * it as a warning) rather than aborting startup, so a read-only or full backup
 * directory cannot brick a gateway that would otherwise migrate cleanly.
 */
export function createPreMigrationStateBackup(
  db: DatabaseSync,
  pathname: string,
  fromVersion: number,
  toVersion: number,
  now: number,
): PreMigrationBackupResult {
  // Only protect a populated database that is actually being upgraded forward.
  // Version 0 is a brand new empty database with nothing to lose.
  if (fromVersion <= 0 || fromVersion >= toVersion) {
    return { status: "skipped", reason: "no forward schema migration pending" };
  }
  try {
    const backupDir = path.join(path.dirname(pathname), PRE_MIGRATION_BACKUP_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      backupDir,
      `openclaw-state-v${fromVersion}-to-v${toVersion}-${stamp}.sqlite`,
    );
    // VACUUM INTO fails if the target already exists; the timestamp keeps the
    // name unique. Escape single quotes for the SQL string literal.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`);
    fs.chmodSync(backupPath, 0o600);
    return { status: "created", backupPath };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
