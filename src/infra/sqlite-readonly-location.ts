// Prepares consistent private SQLite read-only snapshots.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";
import {
  createPrivateSqliteTempDirectory,
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import { runSqliteReadOnlyWorker, runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";

const MAX_SNAPSHOT_ATTEMPTS = 10;
const COPY_BUFFER_BYTES = 1024 * 1024;
const SQLITE_HEADER_BYTES = 20;
const SQLITE_READONLY_RESULT_CODE = 8;
const SQLITE_RESULT_CODE_MASK = 0xff;
const SQLITE_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const SQLITE_SNAPSHOT_STAGING_PREFIX = `openclaw-sqlite-readonly-${process.pid}-`;
const pendingTempDirectoryCleanup = new Set<string>();
let cleanupExitHandlerInstalled = false;

type PinnedFile = {
  descriptor: number;
  identity: BigIntStats;
  pathname: string;
};

type SourceSidecars = {
  journal: boolean;
  shm: boolean;
  wal: boolean;
};

type SourceJournalMode = "empty" | "rollback" | "unknown" | "wal";

type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  location: string;
};

class SqliteSourceChangedError extends Error {}

function sqliteSnapshotStagingError(tempDir: string, cause: unknown, allocation = false): unknown {
  for (let depth = 0, error = cause; depth < 8 && error instanceof Error; depth += 1) {
    const { code, errcode, path: errorPath }: NodeJS.ErrnoException & { errcode?: unknown } = error;
    // SQLite FULL and IOERR_WRITE/FSYNC/DIR_FSYNC identify destination writes.
    if (
      allocation ||
      ["ENOSPC", "EDQUOT"].includes(code ?? "") ||
      (typeof errcode === "number" && [13, 778, 1034, 1290].includes(errcode)) ||
      `${errorPath ?? ""}${path.sep}`.startsWith(`${tempDir}${path.sep}`)
    ) {
      const message = `${cause instanceof Error ? cause.message : String(cause)}${typeof errcode === "number" ? ` (SQLite errcode=${errcode})` : ""}; snapshot staging root ${allocation ? tempDir : path.dirname(tempDir)}: free disk space/quota or set XDG_CACHE_HOME to a writable filesystem`;
      return new Error(message, { cause });
    }
    error = error.cause;
  }
  return cause;
}

function statIfPresent(pathname: string): BigIntStats | undefined {
  try {
    return fs.statSync(pathname, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readSourceSidecars(pathname: string): SourceSidecars {
  return {
    journal: Boolean(statIfPresent(`${pathname}-journal`)),
    shm: Boolean(statIfPresent(`${pathname}-shm`)),
    wal: Boolean(statIfPresent(`${pathname}-wal`)),
  };
}

function sameSidecars(left: SourceSidecars, right: SourceSidecars): boolean {
  return left.journal === right.journal && left.shm === right.shm && left.wal === right.wal;
}

function openPinnedFile(pathname: string): PinnedFile {
  let descriptor: number;
  try {
    descriptor = fs.openSync(pathname, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SqliteSourceChangedError(`SQLite source disappeared: ${pathname}`);
    }
    throw error;
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const current = statIfPresent(pathname);
    if (!identity.isFile() || !current?.isFile() || !sameFileIdentity(identity, current)) {
      throw new SqliteSourceChangedError(`SQLite source changed while opening: ${pathname}`);
    }
    return { descriptor, identity, pathname };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readSourceJournalMode(pathname: string): SourceJournalMode {
  const source = openPinnedFile(pathname);
  try {
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const bytesRead = fs.readSync(source.descriptor, header, 0, header.length, 0);
    const confirmedHeader = Buffer.alloc(SQLITE_HEADER_BYTES);
    const confirmedBytesRead = fs.readSync(
      source.descriptor,
      confirmedHeader,
      0,
      confirmedHeader.length,
      0,
    );
    assertPinnedIdentityUnchanged(source);
    if (bytesRead === 0 && confirmedBytesRead === 0) {
      return "empty";
    }
    if (
      bytesRead !== header.length ||
      confirmedBytesRead !== confirmedHeader.length ||
      !header.equals(confirmedHeader) ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      return "unknown";
    }
    return header[18] === 2 || header[19] === 2 ? "wal" : "rollback";
  } finally {
    fs.closeSync(source.descriptor);
  }
}

function assertPinnedIdentityUnchanged(file: PinnedFile): void {
  const opened = fs.fstatSync(file.descriptor, { bigint: true });
  const current = statIfPresent(file.pathname);
  if (
    !opened.isFile() ||
    !current?.isFile() ||
    !sameFileIdentity(file.identity, opened) ||
    !sameFileIdentity(file.identity, current)
  ) {
    throw new SqliteSourceChangedError(`SQLite source changed while copying: ${file.pathname}`);
  }
}

function copyPinnedFile(source: PinnedFile, targetPath: string): void {
  let target: number | undefined;
  try {
    target = fs.openSync(targetPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(source.descriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const count = fs.writeSync(
          target,
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          offset + bytesWritten,
        );
        if (count === 0) {
          throw new Error(`SQLite read-only snapshot copy made no progress: ${targetPath}`);
        }
        bytesWritten += count;
      }
      offset += bytesRead;
    }
    fs.fsyncSync(target);
    assertPinnedIdentityUnchanged(source);
  } finally {
    if (target !== undefined) {
      fs.closeSync(target);
    }
  }
}

function copySourceFile(sourcePath: string, targetPath: string): void {
  const source = openPinnedFile(sourcePath);
  try {
    copyPinnedFile(source, targetPath);
  } finally {
    fs.closeSync(source.descriptor);
  }
}

function filesEqual(leftPath: string, rightPath: string): boolean {
  const leftStat = fs.statSync(leftPath, { bigint: true });
  const rightStat = fs.statSync(rightPath, { bigint: true });
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) {
    return false;
  }
  const left = fs.openSync(leftPath, "r");
  const right = fs.openSync(rightPath, "r");
  try {
    const leftBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    const rightBuffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let offset = 0;
    while (BigInt(offset) < leftStat.size) {
      const length = Math.min(COPY_BUFFER_BYTES, Number(leftStat.size - BigInt(offset)));
      const leftBytes = fs.readSync(left, leftBuffer, 0, length, offset);
      const rightBytes = fs.readSync(right, rightBuffer, 0, length, offset);
      if (
        leftBytes !== rightBytes ||
        leftBytes !== length ||
        !leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))
      ) {
        return false;
      }
      offset += leftBytes;
    }
    return true;
  } finally {
    fs.closeSync(right);
    fs.closeSync(left);
  }
}

function assertExpectedSidecars(pathname: string, expected: SourceSidecars): void {
  if (!sameSidecars(readSourceSidecars(pathname), expected)) {
    throw new SqliteSourceChangedError(`SQLite journal state changed while copying: ${pathname}`);
  }
}

function replaceFile(sourcePath: string, targetPath: string): void {
  fs.rmSync(targetPath, { force: true });
  fs.renameSync(sourcePath, targetPath);
}

function isSqliteReadOnlyError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const details = current as { cause?: unknown; errcode?: unknown };
    if (
      typeof details.errcode === "number" &&
      (details.errcode & SQLITE_RESULT_CODE_MASK) === SQLITE_READONLY_RESULT_CODE
    ) {
      return true;
    }
    current = details.cause;
  }
  return false;
}

function rollbackJournalReferencesSuperJournal(journalPath: string): boolean {
  const descriptor = fs.openSync(journalPath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size < 16) {
      return false;
    }
    const trailer = Buffer.allocUnsafe(16);
    if (
      fs.readSync(descriptor, trailer, 0, trailer.length, size - trailer.length) !== trailer.length
    ) {
      return false;
    }
    const nameBytes = trailer.readUInt32BE(0);
    return (
      nameBytes > 0 && nameBytes <= size - 20 && trailer.subarray(8).equals(SQLITE_JOURNAL_MAGIC)
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeTempDirectory(tempDir: string): boolean {
  try {
    fs.rmSync(tempDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
    pendingTempDirectoryCleanup.delete(tempDir);
    return true;
  } catch {
    pendingTempDirectoryCleanup.add(tempDir);
    if (!cleanupExitHandlerInstalled) {
      cleanupExitHandlerInstalled = true;
      process.once("exit", () => {
        for (const pendingDir of pendingTempDirectoryCleanup) {
          try {
            fs.rmSync(pendingDir, { force: true, recursive: true });
          } catch {
            // The directory is private and remains registered until process teardown completes.
          }
        }
      });
    }
    return false;
  }
}

function adoptPreparedLocation(
  location: string,
  ownedRoot?: string,
  requireCleanup = false,
): PreparedSqliteReadOnlyLocation {
  const tempDir = ownedRoot ?? path.dirname(location);
  let active = true;
  return {
    location,
    cleanup: () => {
      if (!active) {
        return true;
      }
      const removed = removeTempDirectory(tempDir);
      if (removed) {
        active = false;
      } else if (requireCleanup) {
        throw new Error(`SQLite read-only worker snapshot cleanup failed: ${tempDir}`);
      }
      return removed;
    },
  };
}

function recoverPrivateRollbackCopy(snapshotPath: string): void {
  if (rollbackJournalReferencesSuperJournal(`${snapshotPath}-journal`)) {
    throw new Error(
      `SQLite hot rollback journal references a super-journal and cannot be recovered privately: ${snapshotPath}`,
    );
  }
  const snapshot = openNodeSqliteDatabase(snapshotPath);
  try {
    snapshot.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
    snapshot.prepare("PRAGMA schema_version;").get();
  } finally {
    snapshot.close();
  }
  fs.rmSync(`${snapshotPath}-journal`, { force: true });
  const descriptor = fs.openSync(snapshotPath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createStableReadOnlyCopyInTempDirectory(
  pathname: string,
  journalMode: SourceJournalMode,
  existingTempDir?: string,
  stagingRoot = existingTempDir
    ? path.dirname(existingTempDir)
    : resolvePrivateSqliteSnapshotStagingRoot(),
): PreparedSqliteReadOnlyLocation {
  let tempDir = existingTempDir;
  try {
    tempDir ??= createPrivateSqliteTempDirectorySync(stagingRoot, SQLITE_SNAPSHOT_STAGING_PREFIX);
    const snapshotPath = path.join(tempDir, "database.sqlite");
    const firstPath = path.join(tempDir, "first");
    const secondPath = path.join(tempDir, "second");
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    if (readSourceJournalMode(pathname) !== journalMode) {
      throw new SqliteSourceChangedError(`SQLite journal mode changed before copying: ${pathname}`);
    }
    const sidecars = readSourceSidecars(pathname);
    if (sidecars.journal && sidecars.wal) {
      throw new SqliteSourceChangedError(`SQLite journal modes overlapped: ${pathname}`);
    }
    const sidecarSuffix = sidecars.journal ? "-journal" : sidecars.wal ? "-wal" : undefined;
    if (sidecarSuffix) {
      copySourceFile(`${pathname}${sidecarSuffix}`, firstPath);
      copySourceFile(pathname, snapshotPath);
      copySourceFile(`${pathname}${sidecarSuffix}`, secondPath);
      assertExpectedSidecars(pathname, sidecars);
      if (!filesEqual(firstPath, secondPath)) {
        const label = sidecarSuffix === "-wal" ? "WAL" : "rollback journal";
        throw new SqliteSourceChangedError(`SQLite ${label} changed while copying: ${pathname}`);
      }
      replaceFile(secondPath, `${snapshotPath}${sidecarSuffix}`);
    } else {
      copySourceFile(pathname, firstPath);
      assertExpectedSidecars(pathname, sidecars);
      copySourceFile(pathname, secondPath);
      assertExpectedSidecars(pathname, sidecars);
      if (!filesEqual(firstPath, secondPath)) {
        throw new SqliteSourceChangedError(
          `SQLite main database changed while copying: ${pathname}`,
        );
      }
      replaceFile(secondPath, snapshotPath);
    }

    if (readSourceJournalMode(pathname) !== journalMode) {
      throw new SqliteSourceChangedError(`SQLite journal mode changed while copying: ${pathname}`);
    }
    fs.rmSync(firstPath, { force: true });
    if (sidecars.journal) {
      // Recover only the private pair. The source journal remains untouched so
      // a later writable open can perform SQLite's normal crash recovery.
      recoverPrivateRollbackCopy(snapshotPath);
    }
    return adoptPreparedLocation(snapshotPath);
  } catch (error) {
    if (tempDir) {
      removeTempDirectory(tempDir);
    }
    throw sqliteSnapshotStagingError(tempDir ?? stagingRoot, error, !tempDir);
  }
}

async function createSqliteSnapshotStagingDirectory(
  stagingRoot = resolvePrivateSqliteSnapshotStagingRoot(),
): Promise<string> {
  try {
    return await createPrivateSqliteTempDirectory(stagingRoot, SQLITE_SNAPSHOT_STAGING_PREFIX);
  } catch (error) {
    throw sqliteSnapshotStagingError(stagingRoot, error, true);
  }
}

async function createStableReadOnlyCopy(
  pathname: string,
  journalMode: Exclude<SourceJournalMode, "unknown">,
  stagingRoot?: string,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createSqliteSnapshotStagingDirectory(stagingRoot);
  return createStableReadOnlyCopyInTempDirectory(pathname, journalMode, tempDir);
}

async function createOnlineReadOnlyBackup(
  pathname: string,
  stagingRoot?: string,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createSqliteSnapshotStagingDirectory(stagingRoot);
  const snapshotPath = path.join(tempDir, "database.sqlite");
  const sqlite = requireNodeSqlite();
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    const source = openNodeSqliteDatabase(pathname, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF; BEGIN;");
      source.prepare("PRAGMA schema_version;").get();
      await sqlite.backup(source, resolveSqliteFilesystemPath(snapshotPath));
      source.exec("ROLLBACK;");
    } finally {
      if (source.isOpen) {
        source.close();
      }
    }
    const snapshot = openNodeSqliteDatabase(snapshotPath);
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE;");
    } finally {
      snapshot.close();
    }
    const descriptor = fs.openSync(snapshotPath, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return adoptPreparedLocation(snapshotPath);
  } catch (error) {
    removeTempDirectory(tempDir);
    throw sqliteSnapshotStagingError(tempDir, error);
  }
}

/**
 * Active rollback and WAL state use SQLite's locking and backup protocol.
 * Crash residue that cannot be opened read-only is copied and recovered
 * privately so inspection never mutates coordination files beside the source.
 * The InProcess exports are child-only: POSIX close() can release every lock
 * the calling process holds on the same source inode.
 */
export async function prepareSqliteReadOnlyLocationInProcess(
  pathname: string,
  stagingRoot?: string,
): Promise<PreparedSqliteReadOnlyLocation> {
  const canonicalPath = fs.realpathSync.native(pathname);
  let lastChange: Error | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let journalMode: ReturnType<typeof readSourceJournalMode>;
    try {
      journalMode = readSourceJournalMode(canonicalPath);
    } catch (error) {
      if (!(error instanceof SqliteSourceChangedError)) {
        throw error;
      }
      lastChange = error;
      continue;
    }
    if (journalMode === "empty") {
      try {
        return await createStableReadOnlyCopy(canonicalPath, journalMode, stagingRoot);
      } catch (error) {
        if (!(error instanceof SqliteSourceChangedError)) {
          throw error;
        }
        lastChange = error;
        continue;
      }
    }
    const sidecars = readSourceSidecars(canonicalPath);
    if (journalMode !== "wal" || (sidecars.wal && sidecars.shm)) {
      try {
        return await createOnlineReadOnlyBackup(canonicalPath, stagingRoot);
      } catch (error) {
        // A writer can add or remove sidecars before SQLite opens. Retry
        // incomplete WAL state or rollback crash residue through private copy.
        let currentMode: ReturnType<typeof readSourceJournalMode>;
        try {
          currentMode = readSourceJournalMode(canonicalPath);
        } catch (inspectionError) {
          if (!(inspectionError instanceof SqliteSourceChangedError)) {
            throw inspectionError;
          }
          lastChange = inspectionError;
          continue;
        }
        const currentSidecars = readSourceSidecars(canonicalPath);
        if (currentMode === "rollback" && currentSidecars.journal) {
          if (!isSqliteReadOnlyError(error)) {
            throw error;
          }
          try {
            return await createStableReadOnlyCopy(canonicalPath, "rollback", stagingRoot);
          } catch (copyError) {
            if (!(copyError instanceof SqliteSourceChangedError)) {
              throw copyError;
            }
            lastChange = copyError;
            continue;
          }
        }
        if (currentMode !== "wal" || (currentSidecars.wal && currentSidecars.shm)) {
          throw error;
        }
        lastChange = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }
    try {
      return await createStableReadOnlyCopy(canonicalPath, "wal", stagingRoot);
    } catch (error) {
      if (!(error instanceof SqliteSourceChangedError)) {
        throw error;
      }
      lastChange = error;
    }
  }
  throw new Error(`SQLite source did not stabilize for read-only inspection: ${canonicalPath}`, {
    cause: lastChange,
  });
}

export function prepareSqliteReadOnlyLocationSyncInProcess(
  pathname: string,
  stagingRoot?: string,
): PreparedSqliteReadOnlyLocation {
  const canonicalPath = fs.realpathSync.native(pathname);
  let lastChange: Error | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let journalMode: SourceJournalMode;
    try {
      journalMode = readSourceJournalMode(canonicalPath);
    } catch (error) {
      if (!(error instanceof SqliteSourceChangedError)) {
        throw error;
      }
      lastChange = error;
      continue;
    }
    try {
      // Stable malformed bytes still belong to SQLite's diagnostic path. The
      // private copy checks bytes, sidecars, and mode before a reader opens it.
      return createStableReadOnlyCopyInTempDirectory(
        canonicalPath,
        journalMode,
        undefined,
        stagingRoot,
      );
    } catch (error) {
      if (!(error instanceof SqliteSourceChangedError)) {
        throw error;
      }
      lastChange = error;
    }
  }
  throw new Error(`SQLite source did not stabilize for read-only inspection: ${canonicalPath}`, {
    cause: lastChange,
  });
}

export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  let stagingRoot: string | undefined;
  try {
    options.signal?.throwIfAborted();
    // A stopped worker may never publish its random snapshot path. Allocate its
    // private parent first so cancellation can join the child and remove all copies.
    stagingRoot = await createSqliteSnapshotStagingDirectory();
    options.signal?.throwIfAborted();
    const location = await runSqliteReadOnlyWorker(pathname, {
      mode: options.preserveSourceArtifacts ? "sync" : "async",
      signal: options.signal,
      stagingRoot,
    });
    options.signal?.throwIfAborted();
    // Cancellable maintenance must retain its fence on cleanup failure; ordinary
    // read-only handles report false so their owner can retry close.
    return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
  } catch (error) {
    if (stagingRoot && !removeTempDirectory(stagingRoot)) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
    }
    options.signal?.throwIfAborted();
    throw error;
  }
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  const stagingRoot = createPrivateSqliteTempDirectorySync(
    resolvePrivateSqliteSnapshotStagingRoot(),
    SQLITE_SNAPSHOT_STAGING_PREFIX,
  );
  try {
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    try {
      return await operation(prepared?.location ?? pathname);
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    prepared?.cleanup();
  }
}
