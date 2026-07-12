// Creates compact SQLite snapshots only after verifying both source and output.
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { formatErrorMessage } from "./errors.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

export type SqliteSnapshotValidator = (database: DatabaseSync, databaseLabel: string) => void;

export type CreateVerifiedSqliteSnapshotOptions = {
  sourcePath: string;
  targetPath: string;
  transform?: (database: DatabaseSync) => void | Promise<void>;
  validate?: SqliteSnapshotValidator;
};

export type VerifiedSqliteSnapshot = {
  path: string;
  userVersion: number;
};

async function assertRegularSourceFile(sourcePath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`SQLite snapshot source must be a regular file: ${sourcePath}`);
  }
}

async function assertTargetAbsent(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`SQLite snapshot target already exists: ${targetPath}`);
}

function isLinkFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  );
}

async function publishSnapshotNoOverwrite(
  stagedPath: string,
  targetPath: string,
  stagedIdentity: Stats,
): Promise<Stats> {
  try {
    await fs.link(stagedPath, targetPath);
    return stagedIdentity;
  } catch (error) {
    if (!isLinkFallbackError(error)) {
      throw error;
    }
    return await copyFileExclusive(stagedPath, targetPath);
  }
}

async function copyFileExclusive(sourcePath: string, targetPath: string): Promise<Stats> {
  const source = await fs.open(sourcePath, "r");
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  let targetIdentity: Stats | undefined;
  try {
    target = await fs.open(targetPath, "wx+", 0o600);
    targetIdentity = await target.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const result = await target.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          offset + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`SQLite snapshot copy made no progress: ${targetPath}`);
        }
        bytesWritten += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await target.sync();
    return targetIdentity;
  } catch (error) {
    if (targetIdentity) {
      await target?.close().catch(() => undefined);
      target = undefined;
      await removePublishedTargetIfOwned(targetPath, targetIdentity);
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncPublishedFile(filePath: string, expectedIdentity: Stats): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    const openedIdentity = await handle.stat();
    if (!sameFileIdentity(expectedIdentity, openedIdentity)) {
      throw new Error(`SQLite snapshot target changed before sync: ${filePath}`);
    }
    await handle.sync();
    const currentIdentity = await fs.lstat(filePath);
    if (!sameFileIdentity(expectedIdentity, currentIdentity)) {
      throw new Error(`SQLite snapshot target changed during sync: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function removePublishedTargetIfOwned(
  filePath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const currentIdentity = await fs.lstat(filePath).catch(() => undefined);
  if (currentIdentity && sameFileIdentity(expectedIdentity, currentIdentity)) {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))
  );
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r").catch((error: unknown) => {
    if (isUnsupportedDirectorySyncError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Compact one SQLite database into a fresh private file and verify the result.
 *
 * The source and output both receive full structural, index, and foreign-key
 * checks. Only a fully verified, synced snapshot is published to the target.
 */
export async function createVerifiedSqliteSnapshot(
  options: CreateVerifiedSqliteSnapshotOptions,
): Promise<VerifiedSqliteSnapshot> {
  await assertRegularSourceFile(options.sourcePath);
  await assertTargetAbsent(options.targetPath);

  const stagingDir = await fs.mkdtemp(
    path.join(path.dirname(options.targetPath), ".sqlite-snapshot-"),
  );
  await fs.chmod(stagingDir, 0o700);
  const stagedPath = path.join(stagingDir, "database.sqlite");
  const sqlite = requireNodeSqlite();
  let stagedIdentity: Stats | undefined;
  let publishedIdentity: Stats | undefined;
  try {
    const source = new sqlite.DatabaseSync(options.sourcePath, {
      allowExtension: true,
      readOnly: true,
    });
    try {
      source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      await loadSqliteVecExtension({ db: source });
      assertSqliteIntegrity(source, options.sourcePath);
      options.validate?.(source, options.sourcePath);
      source.prepare("VACUUM INTO ?").run(stagedPath);
    } finally {
      source.close();
    }

    await fs.chmod(stagedPath, 0o600);
    const snapshot = new sqlite.DatabaseSync(stagedPath, { allowExtension: true });
    try {
      snapshot.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      await loadSqliteVecExtension({ db: snapshot });
      if (options.transform) {
        await options.transform(snapshot);
        // A transform may delete sensitive rows. Compact again so the
        // published artifact cannot retain their bytes in free pages.
        snapshot.exec("VACUUM;");
      }
      assertSqliteIntegrity(snapshot, options.targetPath);
      options.validate?.(snapshot, options.targetPath);
      const userVersion = readSqliteUserVersion(snapshot);
      snapshot.close();
      await syncFile(stagedPath);
      stagedIdentity = await fs.lstat(stagedPath);
      publishedIdentity = await publishSnapshotNoOverwrite(
        stagedPath,
        options.targetPath,
        stagedIdentity,
      );
      const currentIdentity = await fs.lstat(options.targetPath);
      if (!currentIdentity.isFile()) {
        throw new Error(`SQLite snapshot target is not a regular file: ${options.targetPath}`);
      }
      if (!sameFileIdentity(publishedIdentity, currentIdentity)) {
        throw new Error(`SQLite snapshot target changed during publication: ${options.targetPath}`);
      }
      await syncPublishedFile(options.targetPath, publishedIdentity);
      await syncDirectoryBestEffort(path.dirname(options.targetPath));
      return { path: options.targetPath, userVersion };
    } finally {
      if (snapshot.isOpen) {
        snapshot.close();
      }
    }
  } catch (error) {
    const ownedIdentity = publishedIdentity ?? stagedIdentity;
    if (ownedIdentity) {
      await removePublishedTargetIfOwned(options.targetPath, ownedIdentity);
    }
    throw new Error(
      `SQLite database cannot be snapshotted safely: ${options.sourcePath}. ${formatErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
  }
}
