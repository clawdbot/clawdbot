// Configures SQLite WAL and related pragmas for local stores.
import { AsyncLocalStorage } from "node:async_hooks";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { isSqliteLockError, runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

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
const LINUX_NFS_SUPER_MAGIC = 0x6969;
const LINUX_SMB_SUPER_MAGIC = 0x517b;
const LINUX_CIFS_SUPER_MAGIC = 0xff534d42;
const LINUX_SMB2_SUPER_MAGIC = 0xfe534d42;
const LINUX_V9FS_SUPER_MAGIC = 0x01021997; // Linux 9p (V9FS)
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";
// Filesystem classification runs during database open, so never let the fallback probe stall it.
const MOUNT_COMMAND_TIMEOUT_MS = 1_000;
const NETWORK_FILESYSTEM_TYPES = new Set(["cifs", "smbfs", "smb2", "smb3"]);
// Cross-VM filesystems (virtiofs, 9p) cannot provide the shared-memory
// coherence SQLite WAL requires; fall back to rollback journaling.
const CROSS_VM_FILESYSTEM_TYPES = new Set(["virtiofs", "fuse.virtiofs", "9p", "9p2000.l"]);
const JOURNAL_MODE_RETRY_INTERVAL_MS = 10;
const JOURNAL_MODE_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const PROC_SELF_FD_PATH = "/proc/self/fd";
const SQLITE_WAL_SPLIT_BRAIN_FATAL_MESSAGE =
  "SQLite WAL sidecar identity mismatch; terminating without SQLite cleanup";

const log = createSubsystemLogger("infra/sqlite-wal");

// Gateway bootstrap loads the database owner before admitting turns. Long-lived
// maintenance timers must not retain the context of a turn that opens a database.
const runInSqliteMaintenanceContext = AsyncLocalStorage.snapshot();

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
type SqliteFilesystemJournalPolicy = "rollback" | "unsupported" | "wal";
type MountEntry = { mountPoint: string; fsType: string; source?: string };

type SqliteWalSplitBrainEvent = {
  event: "sqlite_wal_sidecar_identity_mismatch";
  databasePath: string;
  descriptorDevice: string;
  descriptorInode: string;
  sidecarPath: string;
  targetDevice?: string;
  targetInode?: string;
};

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
        mountPoint: decodeMountInfoPath(mountPoint),
        fsType,
        ...(suffixFields[1] ? { source: decodeMountInfoPath(suffixFields[1]) } : {}),
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
  if (CROSS_VM_FILESYSTEM_TYPES.has(normalized) || normalized.startsWith("9p")) {
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
      filesystemType === LINUX_SMB2_SUPER_MAGIC ||
      filesystemType === LINUX_V9FS_SUPER_MAGIC
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

function statSqliteSidecarTarget(pathname: string): BigIntStats | undefined {
  try {
    return fs.statSync(pathname, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isSqliteWalSidecarSplitBrain(
  descriptor: BigIntStats,
  target: BigIntStats | undefined,
): boolean {
  return (
    descriptor.nlink === 0n ||
    !target ||
    descriptor.dev !== target.dev ||
    descriptor.ino !== target.ino
  );
}

function detectSqliteWalSplitBrain(databasePath: string): SqliteWalSplitBrainEvent | undefined {
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(PROC_SELF_FD_PATH);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const sidecarPaths = [`${databasePath}-wal`, `${databasePath}-shm`];
  for (const descriptorName of descriptors) {
    const descriptorPath = path.join(PROC_SELF_FD_PATH, descriptorName);
    let linkedPath: string;
    try {
      linkedPath = fs.readlinkSync(descriptorPath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const sidecarPath = sidecarPaths.find(
      (candidate) => linkedPath === candidate || linkedPath === `${candidate} (deleted)`,
    );
    if (!sidecarPath) {
      continue;
    }
    let descriptor: BigIntStats;
    try {
      descriptor = fs.fstatSync(Number(descriptorName), { bigint: true });
    } catch (error) {
      if (hasErrnoCode(error, "EBADF") || hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    try {
      if (fs.readlinkSync(descriptorPath) !== linkedPath) {
        continue;
      }
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const target = statSqliteSidecarTarget(sidecarPath);
    if (!isSqliteWalSidecarSplitBrain(descriptor, target)) {
      continue;
    }
    return {
      event: "sqlite_wal_sidecar_identity_mismatch",
      databasePath,
      descriptorDevice: descriptor.dev.toString(),
      descriptorInode: descriptor.ino.toString(),
      sidecarPath,
      ...(target
        ? {
            targetDevice: target.dev.toString(),
            targetInode: target.ino.toString(),
          }
        : {}),
    };
  }
  return undefined;
}

function terminateForSqliteWalSplitBrain(
  splitBrain: SqliteWalSplitBrainEvent,
  databaseLabel: string | undefined,
): never {
  try {
    fs.writeSync(
      process.stderr.fd,
      `${JSON.stringify({
        level: "fatal",
        subsystem: "infra/sqlite-wal",
        message: SQLITE_WAL_SPLIT_BRAIN_FATAL_MESSAGE,
        ...splitBrain,
        databaseLabel,
        pid: process.pid,
      })}\n`,
    );
  } catch {
    // Containment must proceed even when the diagnostic sink is unavailable.
  }
  // SIGKILL bypasses Node exit hooks that close SQLite caches. process.exit()
  // would re-enter the exact stale-handle cleanup this containment prevents.
  try {
    process.kill(process.pid, "SIGKILL");
  } finally {
    process.abort();
  }
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
  const deadline = performance.now() + retryTimeoutMs;
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
        const remainingMs = Math.max(0, deadline - performance.now());
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
  if (!enableWalJournalMode(db, busyTimeoutMs, options)) {
    return {
      checkpoint: () => true,
      close: () => true,
    };
  }
  enableMacosCheckpointFullfsync(db);
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);
  db.exec(`PRAGMA journal_size_limit = ${DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES};`);
  const tripwireDatabasePath =
    process.platform === "linux" && options.databasePath && fs.existsSync(options.databasePath)
      ? fs.realpathSync.native(options.databasePath)
      : undefined;
  let invalidated = false;
  let splitBrainDetectionEnabled = Boolean(tripwireDatabasePath);
  let splitBrainDetectionWarningLogged = false;

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
      // Page limits do not bound lock waits; service worker commit requests before taking the lock.
      runSqliteImmediateTransactionSync(
        db,
        () => db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_MAX_PAGES_PER_PASS});`),
        {
          busyTimeoutMs: options.busyTimeoutMs,
          databaseLabel: options.databaseLabel ?? options.databasePath,
          operationLabel: "incremental-vacuum",
        },
      );
    } catch (error) {
      options.onCheckpointError?.(error);
    }
  };

  const checkpoint = (): boolean => !invalidated && runCheckpoint(checkpointMode);

  let timer: IntervalHandle | null = null;
  if (timerIntervalMs > 0) {
    timer = runInSqliteMaintenanceContext(
      () =>
        setInterval(() => {
          if (tripwireDatabasePath && splitBrainDetectionEnabled) {
            let splitBrain: SqliteWalSplitBrainEvent | undefined;
            try {
              splitBrain = detectSqliteWalSplitBrain(tripwireDatabasePath);
            } catch (error) {
              splitBrainDetectionEnabled = false;
              if (!splitBrainDetectionWarningLogged) {
                splitBrainDetectionWarningLogged = true;
                log.warn("SQLite WAL split-brain detection disabled", {
                  databaseLabel: options.databaseLabel,
                  databasePath: tripwireDatabasePath,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            if (splitBrain) {
              invalidated = true;
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
              terminateForSqliteWalSplitBrain(splitBrain, options.databaseLabel);
            }
          }
          runCheckpoint(periodicCheckpointMode);
          runIncrementalVacuum();
        }, timerIntervalMs) as IntervalHandle,
    );
    timer.unref?.();
  }

  return {
    checkpoint,
    close: (closeOptions) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (invalidated) {
        return false;
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
