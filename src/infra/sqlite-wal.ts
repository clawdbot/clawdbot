// Configures SQLite WAL and related pragmas for local stores.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-transaction.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
const DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
// SQLite applies this ceiling when a fully checkpointed WAL resets on the next
// commit. Keep it well above the usual ~4 MiB autocheckpoint window so only
// pathological high-water marks pay the truncation cost.
const DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
// 512 pages (~2MB at 4KB pages) per periodic pass keeps page release strictly
// bounded so maintenance can never behave like a blocking full VACUUM.
const INCREMENTAL_VACUUM_MAX_PAGES_PER_PASS = 512;
// Memory-mapped reads are enabled only on the WAL path below, i.e. only for
// databases on local filesystems. Network-backed databases take the rollback
// branch and never reach it: mmap over NFS/SMB is what produced the SIGBUS
// crashes behind #60349, and an I/O error on a mapped page raises a signal
// SQLite cannot catch.
//
// 64 MiB is a deliberate bound rather than a generous one. mmap_size is a
// ceiling, not an allocation - SQLite maps only the pages it touches - so
// resident memory tracks the working set and is identical at 64, 128 and
// 256 MiB. The ceiling only binds for databases larger than itself, so
// keeping it low bounds per-connection mapping across the
// OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP handles without costing throughput:
// measured read latency is the same at 64 MiB as at 256 MiB.
const DEFAULT_SQLITE_MMAP_SIZE_BYTES = 64 * 1024 * 1024;
const LINUX_NFS_SUPER_MAGIC = 0x6969;
const LINUX_SMB_SUPER_MAGIC = 0x517b;
const LINUX_CIFS_SUPER_MAGIC = 0xff534d42;
const LINUX_SMB2_SUPER_MAGIC = 0xfe534d42;
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";
// Filesystem classification runs during database open, so never let the fallback probe stall it.
const MOUNT_COMMAND_TIMEOUT_MS = 1_000;
const NETWORK_FILESYSTEM_TYPES = new Set(["cifs", "smbfs", "smb2", "smb3"]);
// mmap eligibility requires a positive match against this list rather than
// merely avoiding the network/FUSE blocklist below: an unrecognized mount
// type (a remote or virtual filesystem this classifier does not know about,
// e.g. 9p, ceph, glusterfs, davfs) must fail closed instead of silently
// reaching PRAGMA mmap_size.
const LOCAL_DISK_FILESYSTEM_TYPES = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "jfs",
  "reiserfs",
  "reiser4",
  "f2fs",
  "zfs",
  "ufs",
  "ntfs",
  "ntfs3",
  "vfat",
  "msdos",
  "exfat",
  "iso9660",
  "udf",
  "hfs",
  "hfsplus",
  "apfs",
]);
const JOURNAL_MODE_RETRY_INTERVAL_MS = 10;
const JOURNAL_MODE_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
// "wal" means the filesystem was positively classified as safe for mmap: a
// matched mount entry or statfs type on LOCAL_DISK_FILESYSTEM_TYPES's
// allowlist. Not being NFS/SMB/CIFS/SMB2/FUSE is not enough - an unrecognized
// mount type must fail closed rather than default to mmap-eligible.
// "wal-unverified" means WAL is still fine to use, but classification was
// inconclusive (no matching mount entry, no resolvable parent, a matched
// mount entry whose filesystem type is not on the local-disk allowlist,
// etc.) - it must never be treated as a positive local result for mmap
// purposes.
// "wal-mmap-ineligible" means WAL is still fine (a non-SSHFS MacFUSE/OSXFUSE
// mount is not the network-coordination hazard SSHFS is), but the mount is a
// FUSE passthrough that can sit in front of an arbitrary, possibly
// network-backed, filesystem, so it must never reach the mmap pragma either.
type SqliteFilesystemJournalPolicy =
  | "rollback"
  | "unsupported"
  | "wal"
  | "wal-unverified"
  | "wal-mmap-ineligible";
type MountEntry = { mountPoint: string; fsType: string; source?: string };

export type SqliteWalMaintenance = {
  checkpoint: () => boolean;
  close: (options?: { checkpointMode?: SqliteWalCheckpointMode }) => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = {
  autoCheckpointPages?: number;
  busyTimeoutMs?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

export type SqliteConnectionPragmaOptions = SqliteWalMaintenanceOptions & {
  foreignKeys?: boolean;
  synchronous?: "NORMAL";
};

function configureSqliteBusyTimeout(db: DatabaseSync, busyTimeoutMs: number): number {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  db.exec(`PRAGMA busy_timeout = ${normalizedTimeoutMs};`);
  return normalizedTimeoutMs;
}

// auto_vacuum only takes effect when set before the first page is written.
// Existing databases require an offline VACUUM owned by doctor/maintenance.
function enableIncrementalAutoVacuumForFreshDatabase(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA page_count").get() as { page_count?: unknown } | undefined;
  if (row?.page_count === 0) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  }
}

/**
 * Configure lock retry before inspecting or mutating a fresh database header.
 * Concurrent first opens can otherwise fail before schema transactions begin.
 */
export function configureSqlitePreSchemaPragmas(
  db: DatabaseSync,
  options: Pick<SqliteConnectionPragmaOptions, "busyTimeoutMs"> = {},
): void {
  if (options.busyTimeoutMs !== undefined) {
    configureSqliteBusyTimeout(db, options.busyTimeoutMs);
  }
  enableIncrementalAutoVacuumForFreshDatabase(db);
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
      const source = linuxMatch[1];
      const mountPoint = linuxMatch[2];
      const fsType = linuxMatch[3];
      if (source && mountPoint && fsType) {
        entries.push({ source, mountPoint, fsType });
      }
      continue;
    }
    const bsdMatch = /^(.+) on (.+) \(([^,\s)]+)/.exec(line);
    if (bsdMatch) {
      const source = bsdMatch[1];
      const mountPoint = bsdMatch[2];
      const fsType = bsdMatch[3];
      if (source && mountPoint && fsType) {
        entries.push({ source, mountPoint, fsType });
      }
    }
  }
  return entries;
}

function isMountCommandTimeout(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT"
  );
}

function readMountEntries(): Result<MountEntry[], "timeout"> {
  try {
    return {
      ok: true,
      value: parseProcMountInfoEntries(fs.readFileSync(PROC_MOUNTINFO_PATH, "utf8")),
    };
  } catch {
    // macOS/BSD expose filesystem type names in `mount` output instead of
    // Linux superblock magic, so keep this fallback for named filesystem types.
  }
  try {
    return {
      ok: true,
      value: parseMountCommandEntries(
        String(
          process.getBuiltinModule("node:child_process").execFileSync("mount", [], {
            killSignal: "SIGKILL",
            timeout: MOUNT_COMMAND_TIMEOUT_MS,
          }),
        ),
      ),
    };
  } catch (error) {
    return isMountCommandTimeout(error) ? { ok: false, error: "timeout" } : { ok: true, value: [] };
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
  if (normalized === "macfuse" || normalized === "osxfuse") {
    // SSHFS reported under these names is refused above via source sniffing.
    // A non-SSHFS report is still just a FUSE passthrough: it can front an
    // arbitrary backing store, so WAL is safe but mmap eligibility is not.
    return isSshfsMountSource(entry.source) ? "unsupported" : "wal-mmap-ineligible";
  }
  if (normalized === "fuse" || normalized.startsWith("fuse.")) {
    // Any other FUSE type (e.g. fuse.rclone) is the same passthrough hazard
    // as macFUSE/OSXFUSE above: it can front an arbitrary, possibly
    // network-backed store that this classifier cannot positively verify.
    return "wal-mmap-ineligible";
  }
  // A matched mount that is not on the network/FUSE blocklist above is not
  // proof of mmap safety - it may be a remote or virtual filesystem this
  // classifier does not recognize (9p, ceph, glusterfs, davfs, autofs, ...).
  // Only a positive match against known local disk filesystem types is
  // mmap-eligible; everything else keeps WAL but falls back to unverified.
  return LOCAL_DISK_FILESYSTEM_TYPES.has(normalized) ? "wal" : "wal-unverified";
}

function resolveMountEntryJournalPolicy(
  targetPath: string,
  mountEntries: MountEntry[],
): SqliteFilesystemJournalPolicy {
  const mountEntry = mountEntries
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  return mountEntry ? resolveMountTypeJournalPolicy(mountEntry) : "wal-unverified";
}

function combineMountEntryJournalPolicies(
  targetPaths: readonly string[],
): SqliteFilesystemJournalPolicy {
  const mountResult = readMountEntries();
  if (!mountResult.ok) {
    return "rollback";
  }
  const policies = new Set(
    targetPaths.map((targetPath) => resolveMountEntryJournalPolicy(targetPath, mountResult.value)),
  );
  if (policies.has("unsupported")) {
    return "unsupported";
  }
  if (policies.has("rollback")) {
    return "rollback";
  }
  // A FUSE passthrough identified via either path representation is enough to
  // distrust mmap eligibility, even if the other representation resolved to a
  // plain "wal" - both describe the same mount, so the more conservative
  // result wins rather than the more permissive one.
  if (policies.has("wal-mmap-ineligible")) {
    return "wal-mmap-ineligible";
  }
  // Require every path representation to positively match a local-disk mount
  // before trusting "wal": a symlinked lexical path can resolve on an
  // allowlisted local mount while its realpath target lands on an
  // unrecognized or unverified mount (or vice versa) - since both describe
  // the same underlying file, trusting whichever representation says "wal"
  // would let that alias enable mmap on a target that was never actually
  // verified as local disk.
  return policies.size === 1 && policies.has("wal") ? "wal" : "wal-unverified";
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
    return "wal-unverified";
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

function hasInMemoryMainDatabase(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA database_list;").all() as Array<{
    file?: unknown;
    name?: unknown;
  }>;
  const main = rows.find((row) => row.name === "main");
  return main?.file === "";
}

function readCheckpointBusyResult(row: unknown): boolean {
  if (!row || typeof row !== "object") {
    return false;
  }
  const record = row as Record<string, unknown>;
  const value = record.busy ?? Object.values(record)[0];
  return value === 1 || value === 1n;
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

function enableWalJournalMode(
  db: DatabaseSync,
  retryTimeoutMs: number,
  options: SqliteWalMaintenanceOptions,
): boolean {
  const deadline = Date.now() + retryTimeoutMs;
  let restoreBusyTimeout = false;
  try {
    while (true) {
      try {
        db.exec("PRAGMA journal_mode = WAL;");
        const journalMode = readJournalModeResult(db.prepare("PRAGMA journal_mode;").get());
        if (journalMode === "wal") {
          return true;
        }
        // SQLite's in-memory databases cannot use WAL and correctly retain
        // journal_mode=memory. They have no sidecars or checkpoint work.
        if (journalMode === "memory" && hasInMemoryMainDatabase(db)) {
          return false;
        }
        const label = options.databaseLabel ?? "sqlite database";
        const location = options.databasePath ? ` at ${options.databasePath}` : "";
        throw new Error(
          `${label}${location} could not enable WAL; SQLite kept journal_mode=${journalMode ?? "unknown"}.`,
        );
      } catch (error) {
        const remainingMs = deadline - Date.now();
        if (!isSqliteLockError(error) || remainingMs <= 0) {
          throw error;
        }
        if (!restoreBusyTimeout) {
          // A busy handler can be bypassed to avoid deadlock. Disable it after
          // the first BUSY so explicit retries cannot overrun this deadline.
          configureSqliteBusyTimeout(db, 0);
          restoreBusyTimeout = true;
        }
        Atomics.wait(
          JOURNAL_MODE_RETRY_SLEEP,
          0,
          0,
          Math.min(JOURNAL_MODE_RETRY_INTERVAL_MS, remainingMs),
        );
      }
    }
  } finally {
    if (restoreBusyTimeout) {
      configureSqliteBusyTimeout(db, retryTimeoutMs);
    }
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
  const busyTimeoutMs =
    options.busyTimeoutMs === undefined ? 0 : configureSqliteBusyTimeout(db, options.busyTimeoutMs);
  const autoCheckpointPages = normalizeSqliteNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeSqliteNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const periodicCheckpointMode = options.checkpointMode ?? "PASSIVE";
  const journalPolicy = options.databasePath
    ? resolvePathJournalPolicy(options.databasePath)
    : "wal-unverified";
  // Only a positively classified local filesystem ("wal") is safe for mmap.
  // "wal-unverified" also runs WAL journaling, but classification could not
  // rule out a network mount, so it must not reach the mmap pragma below.
  // "wal-mmap-ineligible" (non-SSHFS MacFUSE/OSXFUSE) runs WAL too, but a FUSE
  // passthrough can front an arbitrary backing store, so it is excluded the
  // same way.
  // Windows is excluded even on a verified local drive: SQLite cannot
  // truncate a memory-mapped database file there, which conflicts with the
  // incremental auto_vacuum this helper enables and periodically runs below.
  const hasVerifiedLocalPath = journalPolicy === "wal" && process.platform !== "win32";
  if (journalPolicy === "unsupported") {
    refuseUnsupportedFilesystem(options);
  }
  if (journalPolicy === "rollback") {
    requireRollbackJournalMode(db, options);
    // SQLite's default mmap_size is a build-time constant
    // (SQLITE_DEFAULT_MMAP_SIZE) that can be nonzero; omitting this pragma
    // would leave that default in effect on a network-backed connection,
    // which is exactly the mmap-over-network exposure #60349 reports.
    db.exec("PRAGMA mmap_size = 0;");
    return {
      checkpoint: () => true,
      close: () => true,
    };
  }
  if (!enableWalJournalMode(db, busyTimeoutMs, options)) {
    return {
      checkpoint: () => true,
      close: () => true,
    };
  }
  enableMacosCheckpointFullfsync(db);
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);
  db.exec(`PRAGMA journal_size_limit = ${DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES};`);
  // journalPolicy === "wal" means resolvePathJournalPolicy positively matched
  // a mount entry or statfs type on LOCAL_DISK_FILESYSTEM_TYPES's allowlist -
  // the rollback and WAL-refused branches above already returned for network
  // and unsupported mounts. node:sqlite is synchronous, so each page the OS
  // must serve from disk is event-loop block time, which memory-mapped reads
  // cut directly. An inconclusive classification ("wal-unverified": no
  // databasePath, no resolvable parent, no matching mount entry, or a matched
  // mount type not on the local-disk allowlist) keeps mmap off. This pragma
  // is issued either way rather than merely skipped: some SQLite builds
  // compile a nonzero SQLITE_DEFAULT_MMAP_SIZE, and omitting the pragma would
  // leave that build default in effect instead of disabling mmap - an
  // unmapped I/O error is recoverable, but a mapped one raises a signal
  // SQLite cannot catch (#60349).
  db.exec(`PRAGMA mmap_size = ${hasVerifiedLocalPath ? DEFAULT_SQLITE_MMAP_SIZE_BYTES : 0};`);

  const runCheckpoint = (mode: SqliteWalCheckpointMode): boolean => {
    try {
      const row = db.prepare(`PRAGMA wal_checkpoint(${mode});`).get();
      if (readCheckpointBusyResult(row)) {
        const label = options.databaseLabel ?? "sqlite database";
        const error = new Error(`${label} WAL checkpoint ${mode} remained busy`);
        options.onCheckpointError?.(error);
        return false;
      }
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
    close: (closeOptions) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Cache eviction passes PASSIVE: a TRUNCATE close-checkpoint waits on
      // readers and has starved the event loop for seconds under fleet churn.
      // Orderly dispose/delete keeps TRUNCATE so sidecars are flushed for unlink.
      return runCheckpoint(closeOptions?.checkpointMode ?? checkpointMode);
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
  const { foreignKeys, synchronous, ...walOptions } = options;
  const maintenance = configureSqliteWalMaintenance(db, walOptions);
  if (synchronous) {
    db.exec(`PRAGMA synchronous = ${synchronous};`);
  }
  if (foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return maintenance;
}
