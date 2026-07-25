// Prepares consistent private SQLite read-only snapshots.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const MAX_SNAPSHOT_ATTEMPTS = 10;
const COPY_BUFFER_BYTES = 1024 * 1024;
const SQLITE_HEADER_BYTES = 20;
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

type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  location: string;
};

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

function readSourceJournalMode(pathname: string): "rollback" | "unknown" | "wal" {
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

async function createStableReadOnlyCopy(pathname: string): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createPrivateSqliteTempDirectory(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-sqlite-readonly-${process.pid}-`,
  );
  const snapshotPath = path.join(tempDir, "database.sqlite");
  const firstPath = path.join(tempDir, "first");
  const secondPath = path.join(tempDir, "second");
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    if (readSourceJournalMode(pathname) !== "wal") {
      throw new SqliteSourceChangedError(`SQLite journal mode changed before copying: ${pathname}`);
    }
    const sidecars = readSourceSidecars(pathname);
    if (sidecars.journal && sidecars.wal) {
      throw new SqliteSourceChangedError(`SQLite journal modes overlapped: ${pathname}`);
    }

    if (sidecars.wal) {
      copySourceFile(`${pathname}-wal`, firstPath);
      copySourceFile(pathname, snapshotPath);
      copySourceFile(`${pathname}-wal`, secondPath);
      assertExpectedSidecars(pathname, sidecars);
      if (!filesEqual(firstPath, secondPath)) {
        throw new SqliteSourceChangedError(`SQLite WAL changed while copying: ${pathname}`);
      }
      replaceFile(secondPath, `${snapshotPath}-wal`);
    } else if (sidecars.journal) {
      copySourceFile(`${pathname}-journal`, firstPath);
      copySourceFile(pathname, snapshotPath);
      copySourceFile(`${pathname}-journal`, secondPath);
      assertExpectedSidecars(pathname, sidecars);
      if (!filesEqual(firstPath, secondPath)) {
        throw new SqliteSourceChangedError(
          `SQLite rollback journal changed while copying: ${pathname}`,
        );
      }
      replaceFile(secondPath, `${snapshotPath}-journal`);
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

    if (readSourceJournalMode(pathname) !== "wal") {
      throw new SqliteSourceChangedError(`SQLite journal mode changed while copying: ${pathname}`);
    }
    fs.rmSync(firstPath, { force: true });
    let active = true;
    return {
      location: snapshotPath,
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
  } catch (error) {
    removeTempDirectory(tempDir);
    throw error;
  }
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
    let active = true;
    return {
      location: snapshotPath,
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
  } catch (error) {
    removeTempDirectory(tempDir);
    throw error;
  }
}

/**
 * Rollback modes and active WAL state use SQLite's locking and backup protocol.
 * WAL state without a complete WAL/SHM pair is copied privately so inspecting
 * crash residue never creates coordination files beside the source.
 */
export async function prepareSqliteReadOnlyLocation(
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
    const sidecars = readSourceSidecars(canonicalPath);
    if (journalMode !== "wal" || (sidecars.wal && sidecars.shm)) {
      try {
        return await createOnlineReadOnlyBackup(canonicalPath);
      } catch (error) {
        // A last WAL writer can remove sidecars before SQLite opens. Retry the
        // now-sidecar-free WAL through the private-copy path.
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
        if (currentMode !== "wal" || (currentSidecars.wal && currentSidecars.shm)) {
          throw error;
        }
        lastChange = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }
    try {
      return await createStableReadOnlyCopy(canonicalPath);
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
