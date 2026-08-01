import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type PreMigrationBackupResult =
  | { status: "created"; backupPath: string; prunedPaths: string[] }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Snapshot filename shape: `<prefix>v<from>-to-v<to>-<ISO stamp><suffix>`.
 *
 * Split out because pruning matches on it. Only files this module wrote are ever
 * considered for deletion, so an unrelated file that a human parked in the backup
 * directory is left alone.
 */
const BACKUP_FILE_PREFIX = "openclaw-state-v";
const BACKUP_FILE_SUFFIX = ".sqlite";

/**
 * Directory (relative to the state database) that holds pre-migration copies.
 *
 * Module-private on purpose: the directory name is an on-disk contract that
 * operators and tests pin by literal, not a knob other modules read.
 */
const PRE_MIGRATION_BACKUP_DIRNAME = "pre-migration-backups";

/**
 * How many pre-migration copies to keep, newest first.
 *
 * Each copy is a full snapshot of shared state, so keeping every one of them turns
 * a safety net into unbounded growth of sensitive data on disk. Recovery only ever
 * reaches for a recent copy: once a few upgrades have gone through, an older
 * snapshot is too far behind to restore anyway. Three keeps the copy for the
 * current upgrade plus the two before it.
 */
export const PRE_MIGRATION_BACKUP_RETENTION = 3;

/**
 * Delete all but the newest `PRE_MIGRATION_BACKUP_RETENTION` snapshots.
 *
 * Ordered by the timestamp in the filename rather than by mtime: `VACUUM INTO`
 * writes each snapshot once and never touches it again, and a restore-then-copy or
 * a filesystem move can rewrite mtime, which would make the pruning order lie.
 * Returns the paths it removed so the caller can report them.
 *
 * Best effort by contract: every failure is swallowed. A snapshot that cannot be
 * deleted (permissions, a file lock) must never turn a successful backup into a
 * failed migration, and must never abort startup.
 */
function prunePreMigrationBackups(backupDir: string, keep: number): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return removed;
  }
  const snapshots = entries
    .filter((name) => name.startsWith(BACKUP_FILE_PREFIX) && name.endsWith(BACKUP_FILE_SUFFIX))
    .toSorted()
    .toReversed();
  for (const name of snapshots.slice(Math.max(keep, 0))) {
    try {
      fs.rmSync(path.join(backupDir, name));
      removed.push(path.join(backupDir, name));
    } catch {
      // Leave it behind; the next migration tries again.
    }
  }
  return removed;
}

/**
 * Create a consistent, best-effort copy of the shared state database before a
 * forward schema migration bumps its on-disk version.
 *
 * OpenClaw migrates the state schema in place on startup. Once the on-disk
 * `user_version` is raised, an older build refuses to open the database
 * ("uses newer schema version N; this build supports M"), so an interrupted,
 * unwanted, or buggy upgrade has no recovery path unless a copy was taken
 * first. That refusal used to point operators at restoring a compatible
 * backup; #115232 dropped the advice as unactionable, and part of why it was
 * unactionable is that nothing created such a backup. `VACUUM INTO` writes a
 * single consistent snapshot (including
 * committed WAL frames) without holding a write transaction, so it is safe to
 * call on the live handle before the migration transaction begins.
 *
 * This is best effort: a backup failure is reported to the caller (which surfaces
 * it as a warning) rather than aborting startup, so a read-only or full backup
 * directory cannot brick a gateway that would otherwise migrate cleanly.
 *
 * Snapshots are written 0600 inside a 0700 directory, and the directory is capped
 * at `PRE_MIGRATION_BACKUP_RETENTION` copies, so this cannot accumulate shared
 * state on disk without bound.
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
      `${BACKUP_FILE_PREFIX}${fromVersion}-to-v${toVersion}-${stamp}${BACKUP_FILE_SUFFIX}`,
    );
    // VACUUM INTO fails if the target already exists; the timestamp keeps the
    // name unique. Escape single quotes for the SQL string literal.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`); // sqlite-allow-raw -- Offline snapshot maintenance boundary; VACUUM INTO has no Kysely form.
    fs.chmodSync(backupPath, 0o600);
    // Prune only AFTER the new snapshot exists, so a failure above never leaves
    // the directory emptier than it started.
    const prunedPaths = prunePreMigrationBackups(backupDir, PRE_MIGRATION_BACKUP_RETENTION);
    return { status: "created", backupPath, prunedPaths };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
