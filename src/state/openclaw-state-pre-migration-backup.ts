import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const backupLog = createSubsystemLogger("state/db");

const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;

/**
 * Harden a snapshot path, tolerating filesystems that cannot express POSIX modes.
 *
 * Same policy as `ensureOpenClawStatePermissions`: Azure Files, NFS, and Docker
 * volumes cannot chmod, and refusing to work there would deny a recovery copy to
 * exactly the deployments least able to take one by hand (#91919). A real
 * permission failure on a filesystem that does support chmod still throws, and
 * the caller deletes the snapshot rather than leave it unprotected.
 */
function hardenPrivatePath(target: string): void {
  const result = applyPrivateModeSync(
    target,
    fs.statSync(target).isDirectory() ? BACKUP_DIR_MODE : BACKUP_FILE_MODE,
  );
  if (!result.applied) {
    backupLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
  }
}

export type PreMigrationBackupResult =
  /** `reused` marks a copy an earlier attempt at this same migration left behind. */
  | { status: "created"; backupPath: string; reused: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const BACKUP_FILE_PREFIX = "openclaw-state-v";
const BACKUP_FILE_SUFFIX = ".sqlite";

/**
 * Exact snapshot filename shape: `openclaw-state-v<from>-to-v<to>-<ISO stamp>.sqlite`.
 *
 * Anchored, and with the stamp shaped rather than open: a prefix-and-suffix test
 * would also accept `openclaw-state-v5-to-v6-my-own-copy.sqlite`, and this name
 * decides both what may be deleted and what may be trusted as an existing copy.
 */
const BACKUP_FILE_PATTERN =
  /^openclaw-state-v\d+-to-v\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;

/** `SQLite format 3\0`, the header every SQLite database file starts with. */
const SQLITE_HEADER = Buffer.from("53514c69746520666f726d6174203300", "hex");

/**
 * Whether this is a file this module could have written: the exact name shape
 * AND an actual SQLite header.
 *
 * The name alone is not enough in either direction. Reusing a look-alike would
 * report a recovery copy that may not be a database, leaving a migration with no
 * real rollback. Pruning a look-alike would delete a file the operator put there,
 * which is precisely what the managed-file boundary promises not to do.
 */
function isManagedSnapshot(filePath: string, name: string): boolean {
  if (!BACKUP_FILE_PATTERN.test(name)) {
    return false;
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing to do; the classification above already stands.
      }
    }
  }
}

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
function pruneBackupDir(backupDir: string, keep: number): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return removed;
  }
  const snapshots = entries
    .filter((name) => isManagedSnapshot(path.join(backupDir, name), name))
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
 * The `user_version` a snapshot actually holds, or undefined if it cannot be read.
 *
 * Opened read-only and separately from the live handle, because this runs before
 * the migration and must not disturb it.
 */
function readSnapshotUserVersion(filePath: string): number | undefined {
  try {
    const snapshot = openNodeSqliteDatabase(filePath, { readOnly: true });
    try {
      const row = snapshot.prepare("PRAGMA user_version;").get() as
        | { user_version?: number }
        | undefined; // sqlite-allow-raw -- Offline snapshot maintenance boundary; PRAGMA has no Kysely form.
      return row?.user_version;
    } finally {
      snapshot.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The operator-facing line for a snapshot that exists, worded for how it got
 * there. Reusing a copy an earlier attempt left is not the same event as taking
 * one, and reporting both as "backed up" would claim work that did not happen.
 */
export function describePreMigrationSnapshot(
  backup: Extract<PreMigrationBackupResult, { status: "created" }>,
): string {
  return backup.reused
    ? `Reused the pre-migration backup an earlier attempt left → ${backup.backupPath}`
    : `Backed up shared state database before schema migration → ${backup.backupPath}`;
}

/**
 * Cap the snapshot directory at `PRE_MIGRATION_BACKUP_RETENTION` copies, newest
 * first, and return the paths removed.
 *
 * Deliberately separate from creation, and deliberately run only after the
 * migration has committed. Pruning at creation time would delete an older
 * recovery copy on the way into a repair that can still be rejected: the
 * canonical-shape and integrity checks run inside the transaction, so a refused
 * database rolls back with its version untouched, and the fresh snapshot taken
 * moments earlier is merely a duplicate of that unchanged file. Trading a real
 * older copy for a redundant new one is a straight loss of rollback depth.
 *
 * Best effort, like creation: failures are swallowed, and the next successful
 * migration prunes again.
 */
export function prunePreMigrationStateBackups(pathname: string): string[] {
  return pruneBackupDir(
    path.join(path.dirname(pathname), PRE_MIGRATION_BACKUP_DIRNAME),
    PRE_MIGRATION_BACKUP_RETENTION,
  );
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
 * Snapshots are written 0600 inside a 0700 directory. Creation does NOT prune:
 * see `prunePreMigrationStateBackups`, which the caller runs once the migration
 * has actually committed.
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
  let backupPath: string | undefined;
  try {
    const backupDir = path.join(path.dirname(pathname), PRE_MIGRATION_BACKUP_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
    // Harden the directory BEFORE anything sensitive lands in it. `mkdirSync`
    // applies its mode only to directories it actually creates and only through
    // the umask, so a directory that already existed with looser permissions
    // would otherwise stay that way. `VACUUM INTO` creates the snapshot with
    // default permissions and it cannot be pre-created (VACUUM INTO refuses an
    // existing target), so the private directory — not the later file chmod — is
    // what keeps a full copy of shared state unreadable for the window between
    // the two.
    hardenPrivatePath(backupDir);
    // A migration that does not commit leaves the database exactly as this
    // snapshot found it, so a second copy of the same pending upgrade records
    // nothing new. Reuse it. Without this, a database that keeps failing to
    // migrate — a crash-looping gateway, a repeatedly retried repair — writes one
    // full copy of shared state per attempt, and retention cannot save it because
    // pruning only runs after a migration commits. Measured at 11,715 snapshots
    // and 19 GB in six minutes before this check existed.
    const pending = `${BACKUP_FILE_PREFIX}${fromVersion}-to-v${toVersion}-`;
    const reusable = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith(pending))
      .toSorted()
      .toReversed()
      .map((name) => path.join(backupDir, name))
      // Trusting the name alone would let a look-alike stand in for a recovery
      // copy: the migration would skip VACUUM INTO and report a backup that may
      // not be a database at all. Require the managed shape, a SQLite header, and
      // the pre-migration version this copy claims to hold.
      .find(
        (candidate) =>
          isManagedSnapshot(candidate, path.basename(candidate)) &&
          readSnapshotUserVersion(candidate) === fromVersion,
      );
    if (reusable !== undefined) {
      return { status: "created", backupPath: reusable, reused: true };
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(
      backupDir,
      `${BACKUP_FILE_PREFIX}${fromVersion}-to-v${toVersion}-${stamp}${BACKUP_FILE_SUFFIX}`,
    );
    // VACUUM INTO fails if the target already exists; the timestamp keeps the
    // name unique. Escape single quotes for the SQL string literal.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`); // sqlite-allow-raw -- Offline snapshot maintenance boundary; VACUUM INTO has no Kysely form.
    hardenPrivatePath(backupPath);
    return { status: "created", backupPath, reused: false };
  } catch (error) {
    // A snapshot we could not protect is worse than no snapshot: it is a full
    // copy of shared state sitting at whatever permissions it was born with.
    if (backupPath !== undefined) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // Nothing further to try; the reason below is what the operator acts on.
      }
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
