import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  removePreparedBackupArchive,
  type BackupArchiveCleanupReceipt,
  type PreparedBackupArchive,
} from "./backup-create-stream.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";

type BackupArchiveLogger = (message: string) => void;

export type BackupArchivePublication = {
  canonicalOutputPath: string;
  canonicalParentPath: string;
  parentIdentity: Stats;
  pendingCleanupArchives: BackupArchiveCleanupReceipt[];
  requestedOutputPath: string;
  requestedParentPath: string;
  stagingDir: string;
  stagingIdentity: Stats;
  tempArchivePath: string;
};

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
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
  throw new Error(`Refusing to overwrite existing backup archive: ${targetPath}`);
}

async function assertPublicationParentUnchanged(plan: BackupArchivePublication): Promise<void> {
  const currentCanonicalParent = await fs.realpath(plan.requestedParentPath);
  const currentParentIdentity = await fs.lstat(plan.canonicalParentPath);
  if (
    !pathsEqual(currentCanonicalParent, plan.canonicalParentPath) ||
    !currentParentIdentity.isDirectory() ||
    !sameFileIdentity(plan.parentIdentity, currentParentIdentity)
  ) {
    throw new Error(
      `Backup output directory changed during archive creation: ${plan.requestedParentPath}`,
    );
  }
}

async function removeDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: Stats,
): Promise<boolean> {
  // This is a cooperative same-user fence, not hostile local-user isolation;
  // SECURITY.md treats co-equal host mutation as inside the operator boundary.
  const currentIdentity = await fs.lstat(directoryPath).catch(() => undefined);
  if (
    !currentIdentity ||
    !currentIdentity.isDirectory() ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    return false;
  }
  try {
    await fs.rmdir(directoryPath);
    return true;
  } catch {
    return false;
  }
}

async function removeStagingDirectoryIfOwned(plan: BackupArchivePublication): Promise<boolean> {
  return await removeDirectoryIfOwned(plan.stagingDir, plan.stagingIdentity);
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

async function syncPublishedArchiveCommit(
  plan: BackupArchivePublication,
  preparedHandle: FileHandle,
): Promise<void> {
  if (process.platform === "win32") {
    // Windows FlushFileBuffers requires a writable file handle and flushes
    // buffered file metadata. The prepared handle pins the published inode.
    await preparedHandle.sync();
    return;
  }
  const directoryHandle = await fs.open(plan.canonicalParentPath, "r");
  try {
    // Publication success requires a real directory fsync. Unsupported
    // filesystems fail closed instead of weakening crash durability.
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function isUnsupportedHardLinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  );
}

async function openPreparedArchive(
  plan: BackupArchivePublication,
  prepared: PreparedBackupArchive,
): Promise<FileHandle> {
  const accessMode = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const flags = accessMode | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await fs.open(prepared.archivePath, flags);
  try {
    const openedIdentity = await handle.stat();
    const currentIdentity = await fs.lstat(prepared.archivePath);
    if (
      !pathsEqual(path.dirname(prepared.archivePath), plan.stagingDir) ||
      !openedIdentity.isFile() ||
      !currentIdentity.isFile() ||
      !sameFileIdentity(prepared.identity, openedIdentity) ||
      !sameFileIdentity(prepared.identity, currentIdentity)
    ) {
      throw new Error(
        `Backup archive staging file changed before publication: ${prepared.archivePath}`,
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertPublishedArchiveUnchanged(
  plan: BackupArchivePublication,
  handle: FileHandle,
  expectedIdentity: Stats,
): Promise<void> {
  const openedIdentity = await handle.stat();
  const currentIdentity = await fs.lstat(plan.canonicalOutputPath);
  if (
    !openedIdentity.isFile() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(expectedIdentity, openedIdentity) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    throw new Error(`Published backup archive changed: ${plan.requestedOutputPath}`);
  }
}

export async function createBackupArchivePublication(
  outputPath: string,
): Promise<BackupArchivePublication> {
  const requestedOutputPath = path.resolve(outputPath);
  const requestedParentPath = path.dirname(requestedOutputPath);
  const canonicalParentPath = await fs.realpath(requestedParentPath);
  const parentIdentity = await fs.lstat(canonicalParentPath);
  if (!parentIdentity.isDirectory()) {
    throw new Error(`Backup output parent is not a directory: ${requestedParentPath}`);
  }
  const canonicalOutputPath = path.join(canonicalParentPath, path.basename(requestedOutputPath));
  await assertTargetAbsent(canonicalOutputPath);
  const stagingDir = await fs.mkdtemp(
    path.join(canonicalParentPath, `.openclaw-backup-publish-${randomUUID()}-`),
  );
  let stagingIdentity: Stats | undefined;
  try {
    stagingIdentity = await fs.lstat(stagingDir);
    await fs.chmod(stagingDir, 0o700);
    return {
      canonicalOutputPath,
      canonicalParentPath,
      parentIdentity,
      pendingCleanupArchives: [],
      requestedOutputPath,
      requestedParentPath,
      stagingDir,
      stagingIdentity,
      tempArchivePath: path.join(stagingDir, "archive.tar.gz.tmp"),
    };
  } catch (error) {
    if (stagingIdentity) {
      await removeDirectoryIfOwned(stagingDir, stagingIdentity);
    }
    throw error;
  }
}

function retainArchiveForCleanup(
  plan: BackupArchivePublication,
  receipt: BackupArchiveCleanupReceipt,
): void {
  for (const [index, candidate] of plan.pendingCleanupArchives.entries()) {
    if (!pathsEqual(candidate.archivePath, receipt.archivePath)) {
      continue;
    }
    if (!candidate.identity || !receipt.identity) {
      if (!candidate.identity && receipt.identity) {
        plan.pendingCleanupArchives[index] = receipt;
      }
      return;
    }
    if (sameFileIdentity(candidate.identity, receipt.identity)) {
      return;
    }
  }
  plan.pendingCleanupArchives.push(receipt);
}

async function removePendingBackupArchive(
  plan: BackupArchivePublication,
  receipt: BackupArchiveCleanupReceipt,
): Promise<boolean> {
  if (!pathsEqual(path.dirname(receipt.archivePath), plan.stagingDir)) {
    return false;
  }
  if (receipt.identity) {
    return removePreparedBackupArchive(receipt as PreparedBackupArchive);
  }
  let currentIdentity: Stats;
  try {
    currentIdentity = await fs.lstat(receipt.archivePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!currentIdentity.isFile()) {
    return false;
  }
  return removePreparedBackupArchive({
    archivePath: receipt.archivePath,
    identity: currentIdentity,
  });
}

export async function cleanupBackupArchivePublication(
  plan: BackupArchivePublication,
  log?: BackupArchiveLogger,
): Promise<void> {
  const retainedArchives = plan.pendingCleanupArchives.splice(0);
  for (const receipt of retainedArchives) {
    if (!(await removePendingBackupArchive(plan, receipt))) {
      retainArchiveForCleanup(plan, receipt);
    }
  }
  if (await removeStagingDirectoryIfOwned(plan)) {
    await syncDirectoryBestEffort(plan.canonicalParentPath).catch(() => undefined);
    return;
  }
  const currentIdentity = await fs.lstat(plan.stagingDir).catch(() => undefined);
  if (currentIdentity) {
    log?.(`Backup archiver preserved changed or non-empty staging directory ${plan.stagingDir}.`);
  }
}

export async function publishPreparedBackupArchive(params: {
  plan: BackupArchivePublication;
  prepared: PreparedBackupArchive;
  log?: BackupArchiveLogger;
}): Promise<void> {
  const { plan, prepared } = params;
  let preparedHandle: FileHandle | undefined;
  let publishedIdentity: Stats | undefined;
  let hardLinkCreated = false;
  let committed = false;
  try {
    await assertPublicationParentUnchanged(plan);
    preparedHandle = await openPreparedArchive(plan, prepared);
    await assertTargetAbsent(plan.canonicalOutputPath);
    // Node has no portable link-by-handle primitive. Under OpenClaw's one-user
    // host trust model, post-link identity checks fence cooperative replacement
    // races and ensure a changed staging pathname can never produce success.
    try {
      await fs.link(prepared.archivePath, plan.canonicalOutputPath);
      hardLinkCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Refusing to overwrite existing backup archive: ${plan.requestedOutputPath}`,
          { cause: error },
        );
      }
      if (isUnsupportedHardLinkError(error)) {
        throw new Error(
          `Atomic backup publication requires hard-link support in ${plan.requestedParentPath}.`,
          { cause: error },
        );
      }
      throw error;
    }

    await assertPublicationParentUnchanged(plan);
    const currentTargetIdentity = await fs.lstat(plan.canonicalOutputPath);
    const currentStagingIdentity = await fs.lstat(prepared.archivePath);
    if (
      !currentTargetIdentity.isFile() ||
      !currentStagingIdentity.isFile() ||
      !sameFileIdentity(prepared.identity, currentTargetIdentity) ||
      !sameFileIdentity(prepared.identity, currentStagingIdentity)
    ) {
      throw new Error(`Backup archive changed during publication: ${plan.requestedOutputPath}`);
    }
    publishedIdentity = currentTargetIdentity;
    await assertPublishedArchiveUnchanged(plan, preparedHandle, publishedIdentity);

    // The first parent sync commits the final pathname. After this point,
    // cleanup failures must not remove or invalidate the durable archive.
    await syncPublishedArchiveCommit(plan, preparedHandle);
    committed = true;

    if (!removePreparedBackupArchive(prepared)) {
      retainArchiveForCleanup(plan, prepared);
      params.log?.(`Backup archiver preserved changed staging file ${prepared.archivePath}.`);
    }
    if (!(await removeStagingDirectoryIfOwned(plan))) {
      params.log?.(
        `Backup archiver preserved changed or non-empty staging directory ${plan.stagingDir}.`,
      );
    }
    await syncDirectoryBestEffort(plan.canonicalParentPath).catch((error: unknown) => {
      params.log?.(
        `Backup archiver could not sync cleanup in ${plan.canonicalParentPath}: ${
          (error as NodeJS.ErrnoException).code ?? String(error)
        }.`,
      );
    });
    await assertPublicationParentUnchanged(plan);
    await assertPublishedArchiveUnchanged(plan, preparedHandle, publishedIdentity);
  } catch (error) {
    if (!committed) {
      if (!publishedIdentity && hardLinkCreated) {
        const currentTargetIdentity = await fs
          .lstat(plan.canonicalOutputPath)
          .catch(() => undefined);
        if (
          currentTargetIdentity?.isFile() &&
          sameFileIdentity(currentTargetIdentity, prepared.identity)
        ) {
          publishedIdentity = currentTargetIdentity;
        }
      }
      if (publishedIdentity) {
        params.log?.(
          `Backup archiver preserved the final archive after publication failed so a concurrent replacement could not be deleted: ${plan.requestedOutputPath}.`,
        );
      }
      if (!removePreparedBackupArchive(prepared)) {
        retainArchiveForCleanup(plan, prepared);
      }
      await removeStagingDirectoryIfOwned(plan);
    }
    throw error;
  } finally {
    await preparedHandle?.close().catch(() => undefined);
  }
}
