// Configures SQLite WAL and related pragmas for local stores.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
export const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
/**
 * @deprecated Use DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS.
 * Periodic checkpoints default to PASSIVE.
 */
export const DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS = DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS;
// 512 pages (~2MB at 4KB pages) per periodic pass keeps page release strictly
// bounded so maintenance can never behave like a blocking full VACUUM.
const INCREMENTAL_VACUUM_MAX_PAGES_PER_PASS = 512;
const LINUX_NFS_SUPER_MAGIC = 0x6969;
const LINUX_SMB_SUPER_MAGIC = 0x517b;
const LINUX_CIFS_SUPER_MAGIC = 0xff534d42;
const LINUX_SMB2_SUPER_MAGIC = 0xfe534d42;
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";
const NETWORK_FILESYSTEM_TYPES = new Set(["cifs", "smbfs", "smb2", "smb3"]);

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
type SqliteFilesystemJournalPolicy = "rollback" | "unsupported" | "wal";
type MountEntry = { mountPoint: string; fsType: string; source?: string };

export type SqliteWalMaintenance = {
  checkpoint: () => boolean;
  close: () => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = {
  autoCheckpointPages?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

export type SqliteConnectionPragmaOptions = SqliteWalMaintenanceOptions & {
  busyTimeoutMs?: number;
  foreignKeys?: boolean;
  synchronous?: "NORMAL";
};

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function findExistingVolumePaths(
  targetPath: string,
): { canonicalPath: string; originalPath: string } | null {
  let current = path.resolve(targetPath);
  while (true) {
    let stats: ReturnType<typeof fs.statSync>;
    try {
      stats = fs.statSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
      continue;
    }
    const existingPath = fs.realpathSync(current);
    return {
      canonicalPath: stats.isDirectory() ? existingPath : path.dirname(existingPath),
      originalPath: stats.isDirectory() ? current : path.dirname(current),
    };
  }
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseProcMountInfoEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) {
      continue;
    }
    const fields = line.slice(0, separator).split(" ");
    const suffixFields = line.slice(separator + 3).split(" ");
    const mountPoint = fields[4];
    const fsType = suffixFields[0];
    if (mountPoint && fsType) {
      entries.push({
        mountPoint: decodeMountPath(mountPoint),
        fsType,
        ...(suffixFields[1] ? { source: decodeMountPath(suffixFields[1]) } : {}),
      });
    }
  }
  return entries;
}

function parseMountCommandEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    const linuxMatch = /^(.+) on (.+) type ([^,\s)]+) \(/.exec(line);
    if (linuxMatch) {
      entries.push({ source: linuxMatch[1], mountPoint: linuxMatch[2], fsType: linuxMatch[3] });
      continue;
    }
    const bsdMatch = /^(.+) on (.+) \(([^,\s)]+)/.exec(line);
    if (bsdMatch) {
      entries.push({ source: bsdMatch[1], mountPoint: bsdMatch[2], fsType: bsdMatch[3] });
    }
  }
  return entries;
}

function readMountEntries(): MountEntry[] {
  try {
    return parseProcMountInfoEntries(fs.readFileSync(PROC_MOUNTINFO_PATH, "utf8"));
  } catch {
    // macOS/BSD expose filesystem type names in `mount` output instead of
    // Linux superblock magic, so keep this fallback for named filesystem types.
  }
  try {
    return parseMountCommandEntries(String(childProcess.execFileSync("mount", [])));
  } catch {
    return [];
  }
}

function isPathWithinMount(targetPath: string, mountPoint: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedMountPoint = path.resolve(mountPoint);
  return (
    resolvedTarget === resolvedMountPoint ||
    resolvedMountPoint === path.parse(resolvedMountPoint).root ||
    resolvedTarget.startsWith(`${resolvedMountPoint}${path.sep}`)
  );
}

function isSshfsMountSource(source: string | undefined): boolean {
  if (!source) {
    return false;
  }
  const normalized = source.toLowerCase();
  return (
    normalized === "sshfs" ||
    normalized.startsWith("sshfs#") ||
    normalized.startsWith("sshfs@") ||
    /^(?:[^/\s:]+@)?[^/\s:]+:.*/u.test(source)
  );
}

function resolveMountTypeJournalPolicy(entry: MountEntry): SqliteFilesystemJournalPolicy {
  const normalized = entry.fsType.toLowerCase();
  if (normalized.startsWith("nfs") || NETWORK_FILESYSTEM_TYPES.has(normalized)) {
    return "rollback";
  }
  if (normalized === "fuse.sshfs") {
    return "unsupported";
  }
  if ((normalized === "macfuse" || normalized === "osxfuse") && isSshfsMountSource(entry.source)) {
    return "unsupported";
  }
  return "wal";
}

function resolveMountEntryJournalPolicy(
  targetPath: string,
  mountEntries: MountEntry[],
): SqliteFilesystemJournalPolicy {
  const mountEntry = mountEntries
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  return mountEntry ? resolveMountTypeJournalPolicy(mountEntry) : "wal";
}

function combineMountEntryJournalPolicies(
  targetPaths: readonly string[],
): SqliteFilesystemJournalPolicy {
  const mountEntries = readMountEntries();
  const policies = new Set(
    targetPaths.map((targetPath) => resolveMountEntryJournalPolicy(targetPath, mountEntries)),
  );
  if (policies.has("unsupported")) {
    return "unsupported";
  }
  return policies.has("rollback") ? "rollback" : "wal";
}

function isWindowsUncPath(targetPath: string): boolean {
  return (
    /^\\\\\?\\UNC\\[^\\]+\\[^\\]+/i.test(targetPath) ||
    /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(targetPath)
  );
}

function isWindowsDrivePath(targetPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\\?\\[A-Za-z]:[\\/]/i.test(targetPath);
}

function resolvePathJournalPolicy(targetPath: string): SqliteFilesystemJournalPolicy {
  if (process.platform === "win32") {
    const normalizedTargetPath = path.win32.normalize(targetPath);
    if (isWindowsUncPath(normalizedTargetPath)) {
      return "rollback";
    }
    if (isWindowsDrivePath(normalizedTargetPath)) {
      try {
        return isWindowsUncPath(path.win32.normalize(fs.realpathSync.native(targetPath)))
          ? "rollback"
          : "wal";
      } catch {
        // Windows can deny SMB path normalization when parent components are
        // unreadable. Treat an unclassifiable opened database as network-backed.
        return "rollback";
      }
    }
  }
  const checkedPaths = findExistingVolumePaths(targetPath);
  if (!checkedPaths) {
    return "wal";
  }
  const mountLookupPaths = [checkedPaths.originalPath, checkedPaths.canonicalPath];
  if (typeof fs.statfsSync !== "function") {
    return combineMountEntryJournalPolicies(mountLookupPaths);
  }
  try {
    const filesystemType = fs.statfsSync(checkedPaths.canonicalPath).type;
    if (
      filesystemType === LINUX_NFS_SUPER_MAGIC ||
      filesystemType === LINUX_SMB_SUPER_MAGIC ||
      filesystemType === LINUX_CIFS_SUPER_MAGIC ||
      filesystemType === LINUX_SMB2_SUPER_MAGIC
    ) {
      return "rollback";
    }
  } catch {
    return combineMountEntryJournalPolicies(mountLookupPaths);
  }
  return combineMountEntryJournalPolicies(mountLookupPaths);
}

function readJournalModeResult(row: unknown): string | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const value = record.journal_mode ?? Object.values(record)[0];
  return typeof value === "string" ? value.toLowerCase() : null;
}

function requireRollbackJournalMode(db: DatabaseSync, options: SqliteWalMaintenanceOptions): void {
  const row = db.prepare("PRAGMA journal_mode = DELETE;").get();
  const journalMode = readJournalModeResult(row);
  if (journalMode !== "delete") {
    const label = options.databaseLabel ?? "sqlite database";
    const location = options.databasePath ? ` at ${options.databasePath}` : "";
    const actual = journalMode ?? "unknown";
    throw new Error(
      `${label}${location} is on a network-backed volume but SQLite kept journal_mode=${actual}; refusing to continue with WAL on network storage.`,
    );
  }
}

function enableMacosCheckpointFullfsync(db: DatabaseSync): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    db.exec("PRAGMA checkpoint_fullfsync = 1;");
  } catch {
    // Older SQLite builds may ignore or reject platform-specific pragmas. WAL
    // setup should still proceed because this is a durability upgrade, not a
    // prerequisite for opening the store.
  }
}

function refuseUnsupportedFilesystem(options: SqliteWalMaintenanceOptions): never {
  const label = options.databaseLabel ?? "sqlite database";
  const location = options.databasePath ? ` at ${options.databasePath}` : "";
  throw new Error(
    `${label}${location} is on SSHFS, which cannot safely coordinate SQLite writes across mounts; refusing to open the database.`,
  );
}

/** Configure safe journaling pragmas and return a handle for checkpoint/close maintenance. */
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  options: SqliteWalMaintenanceOptions = {},
): SqliteWalMaintenance {
  const autoCheckpointPages = normalizeNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const periodicCheckpointMode = options.checkpointMode ?? "PASSIVE";
  const journalPolicy = options.databasePath
    ? resolvePathJournalPolicy(options.databasePath)
    : "wal";
  if (journalPolicy === "unsupported") {
    refuseUnsupportedFilesystem(options);
  }
  if (journalPolicy === "rollback") {
    requireRollbackJournalMode(db, options);
    return {
      checkpoint: () => true,
      close: () => true,
    };
  }
  db.exec("PRAGMA journal_mode = WAL;");
  enableMacosCheckpointFullfsync(db);
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);

  const runCheckpoint = (mode: SqliteWalCheckpointMode): boolean => {
    try {
      db.exec(`PRAGMA wal_checkpoint(${mode});`);
      return true;
    } catch (error) {
      options.onCheckpointError?.(error);
      return false;
    }
  };

  // Bounded page release for databases opened with auto_vacuum=INCREMENTAL.
  // A no-op elsewhere, and never a blocking full VACUUM: unbounded vacuums on
  // the event loop have starved channel sockets in production (#83712).
  const runIncrementalVacuum = (): void => {
    try {
      db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_MAX_PAGES_PER_PASS});`);
    } catch (error) {
      options.onCheckpointError?.(error);
    }
  };

  const checkpoint = (): boolean => runCheckpoint(checkpointMode);

  let timer: IntervalHandle | null = null;
  if (timerIntervalMs > 0) {
    timer = setInterval(() => {
      runCheckpoint(periodicCheckpointMode);
      runIncrementalVacuum();
    }, timerIntervalMs) as IntervalHandle;
    timer.unref?.();
  }

  return {
    checkpoint,
    close: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return checkpoint();
    },
  };
}

/**
 * Register a best-effort exit-time close for a SQLite handle cache. Returns an
 * unregister callback the cache's orderly close path must invoke, so tests and
 * runtime shutdowns do not accumulate listeners on shared worker processes.
 */
export function registerSqliteCacheExitClose(closeAll: () => void): () => void {
  const closeOnExit = () => {
    try {
      closeAll();
    } catch {
      // Exit-time close is best-effort; unclean exits rely on WAL recovery.
    }
  };
  process.once("exit", closeOnExit);
  return () => {
    process.removeListener("exit", closeOnExit);
  };
}

/** Configure per-connection SQLite pragmas in the safe lock-retry/WAL order. */
export function configureSqliteConnectionPragmas(
  db: DatabaseSync,
  options: SqliteConnectionPragmaOptions = {},
): SqliteWalMaintenance {
  const { busyTimeoutMs, foreignKeys, synchronous, ...walOptions } = options;
  if (busyTimeoutMs !== undefined) {
    db.exec(
      `PRAGMA busy_timeout = ${normalizeNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs")};`,
    );
  }
  const maintenance = configureSqliteWalMaintenance(db, walOptions);
  if (synchronous) {
    db.exec(`PRAGMA synchronous = ${synchronous};`);
  }
  if (foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return maintenance;
}
