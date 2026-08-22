// Prepares consistent private SQLite read-only snapshots.
import { execFile, spawnSync } from "node:child_process";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  createPrivateSqliteTempDirectory,
  createPrivateSqliteTempDirectorySync,
} from "./sqlite-private-directory.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const MAX_SNAPSHOT_ATTEMPTS = 10;
const COPY_BUFFER_BYTES = 1024 * 1024;
const SQLITE_HEADER_BYTES = 20;
const SQLITE_READONLY_RESULT_CODE = 8;
const SQLITE_RESULT_CODE_MASK = 0xff;
const SQLITE_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";
const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;
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

type SqliteReadOnlyWorkerResult = { ok: true; location: string } | { ok: false; message: string };

class SqliteSourceChangedError extends Error {}

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

function adoptPreparedLocation(location: string): PreparedSqliteReadOnlyLocation {
  const tempDir = path.dirname(location);
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
  journalMode: Exclude<SourceJournalMode, "unknown">,
  tempDir: string,
): PreparedSqliteReadOnlyLocation {
  const snapshotPath = path.join(tempDir, "database.sqlite");
  const firstPath = path.join(tempDir, "first");
  const secondPath = path.join(tempDir, "second");
  try {
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
    removeTempDirectory(tempDir);
    throw error;
  }
}

async function createStableReadOnlyCopy(
  pathname: string,
  journalMode: Exclude<SourceJournalMode, "unknown">,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createPrivateSqliteTempDirectory(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-sqlite-readonly-${process.pid}-`,
  );
  return createStableReadOnlyCopyInTempDirectory(pathname, journalMode, tempDir);
}

function createStableReadOnlyCopySync(
  pathname: string,
  journalMode: Exclude<SourceJournalMode, "unknown">,
): PreparedSqliteReadOnlyLocation {
  const tempDir = createPrivateSqliteTempDirectorySync(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-sqlite-readonly-${process.pid}-`,
  );
  return createStableReadOnlyCopyInTempDirectory(pathname, journalMode, tempDir);
}

async function createOnlineReadOnlyBackup(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createPrivateSqliteTempDirectory(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-sqlite-readonly-${process.pid}-`,
  );
  const snapshotPath = path.join(tempDir, "database.sqlite");
  const sqlite = requireNodeSqlite();
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    const source = openNodeSqliteDatabase(pathname, {
      readOnly: true,
    });
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
    throw error;
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
        return await createStableReadOnlyCopy(canonicalPath, journalMode);
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
        return await createOnlineReadOnlyBackup(canonicalPath);
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
            return await createStableReadOnlyCopy(canonicalPath, "rollback");
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
      return await createStableReadOnlyCopy(canonicalPath, "wal");
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
    if (journalMode === "unknown") {
      lastChange = new SqliteSourceChangedError(
        `SQLite journal mode is unavailable while copying: ${canonicalPath}`,
      );
      continue;
    }
    try {
      return createStableReadOnlyCopySync(canonicalPath, journalMode);
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

function resolveSqliteReadOnlyWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-readonly-location.worker",
    distWorkerPath: "infra/sqlite-readonly-location.worker.js",
  });
}

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
  const stderrTail = stderr.trim().slice(-SQLITE_READONLY_STDERR_TAIL_CHARS);
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
  );
}

function parseSqliteReadOnlyWorkerResult(
  stdout: string,
  stderr: string,
): SqliteReadOnlyWorkerResult {
  if (!stdout.trim()) {
    throw createSqliteReadOnlyWorkerError("returned no JSON result", stderr);
  }
  let message: unknown;
  try {
    message = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid JSON", stderr);
  }
  if (!isSqliteReadOnlyWorkerResult(message)) {
    throw createSqliteReadOnlyWorkerError("returned an invalid result", stderr);
  }
  return message;
}

function adoptSqliteReadOnlyWorkerResult(params: {
  failure?: string;
  stderr: string;
  stdout: string;
}): PreparedSqliteReadOnlyLocation {
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr);
    }
    throw error;
  }
  if (params.failure || !result.ok) {
    throw createSqliteReadOnlyWorkerError(
      !result.ok ? result.message : (params.failure ?? "failed"),
      params.stderr,
    );
  }
  return adoptPreparedLocation(result.location);
}

export async function prepareSqliteReadOnlyLocation(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation> {
  const workerUrl = resolveSqliteReadOnlyWorkerUrl();
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(workerUrl),
        SQLITE_READONLY_CHILD_ARG,
        "async",
        path.resolve(pathname),
      ],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        try {
          const failure = error ? `exited unsuccessfully: ${error.message}` : undefined;
          resolve(adoptSqliteReadOnlyWorkerResult({ failure, stderr, stdout }));
        } catch (workerError) {
          reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
        }
      },
    );
  });
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  const workerUrl = resolveSqliteReadOnlyWorkerUrl();
  const result = spawnSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(workerUrl),
      SQLITE_READONLY_CHILD_ARG,
      "sync",
      path.resolve(pathname),
    ],
    { encoding: "utf8" },
  );
  const failure = result.error
    ? `failed to start: ${result.error.message}`
    : result.status === 0
      ? undefined
      : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`;
  return adoptSqliteReadOnlyWorkerResult({ failure, stderr: result.stderr, stdout: result.stdout });
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
