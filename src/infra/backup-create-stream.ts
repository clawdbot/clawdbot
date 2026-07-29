import fsSync, { createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sameFileIdentity } from "./fs-safe-advanced.js";

const BACKUP_ARCHIVE_IDLE_TIMEOUT_MS = 5 * 60_000;

type DestroyableArchiveStream = (NodeJS.ReadableStream | AsyncIterable<Uint8Array>) & {
  destroy(error?: Error): unknown;
};

export type BackupArchiveCleanupReceipt = {
  archivePath: string;
  identity?: Stats;
};

export type PreparedBackupArchive = BackupArchiveCleanupReceipt & {
  identity: Stats;
};

// OpenClaw's one-user trust model treats hostile same-UID pathname rewrites as
// trusted host mutation. Keep the check and unlink synchronous so cooperative
// processes cannot interleave through an in-process await boundary.
export function removePreparedBackupArchive(prepared: PreparedBackupArchive): boolean {
  let currentIdentity: Stats;
  try {
    currentIdentity = fsSync.lstatSync(prepared.archivePath);
  } catch {
    return false;
  }
  if (!currentIdentity.isFile() || !sameFileIdentity(prepared.identity, currentIdentity)) {
    return false;
  }
  try {
    fsSync.unlinkSync(prepared.archivePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeArchiveStreamToFile(params: {
  archivePath: string;
  archiveStream: DestroyableArchiveStream;
  idleTimeoutMs?: number;
  onPartialArchive?: (receipt: BackupArchiveCleanupReceipt) => void;
}): Promise<PreparedBackupArchive> {
  // Own both stream lifecycles so a tar read error closes the output handle
  // before retry cleanup touches the partial archive. Exclusive creation also
  // refuses a pre-existing path instead of following a symlink.
  const idleTimeoutMs = params.idleTimeoutMs ?? BACKUP_ARCHIVE_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let openedIdentity: Stats | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimeoutError: Error | undefined;
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleTimeoutError = new Error(
        `Backup archive write stalled: no data produced for ${idleTimeoutMs}ms`,
      );
      params.archiveStream.destroy(idleTimeoutError);
      controller.abort(idleTimeoutError);
    }, idleTimeoutMs);
  };
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      armIdleTimer();
      callback(null, chunk);
    },
  });

  const archiveWriteStream = createWriteStream(params.archivePath, {
    flags: "wx",
    flush: true,
    mode: 0o600,
  });
  archiveWriteStream.once("open", (fileDescriptor) => {
    try {
      openedIdentity = fsSync.fstatSync(fileDescriptor);
    } catch (error) {
      archiveWriteStream.destroy(error as Error);
    }
  });
  try {
    const pipelinePromise = pipeline(params.archiveStream, progress, archiveWriteStream, {
      signal: controller.signal,
    });
    armIdleTimer();
    await pipelinePromise;
    const currentIdentity = await fs.lstat(params.archivePath);
    if (
      !openedIdentity?.isFile() ||
      !currentIdentity.isFile() ||
      !sameFileIdentity(openedIdentity, currentIdentity)
    ) {
      throw new Error(`Backup archive path changed while writing: ${params.archivePath}`);
    }
    return { archivePath: params.archivePath, identity: currentIdentity };
  } catch (err) {
    archiveWriteStream.destroy();
    let cleanupReceipt: BackupArchiveCleanupReceipt | undefined = openedIdentity
      ? { archivePath: params.archivePath, identity: openedIdentity }
      : undefined;
    if (!cleanupReceipt) {
      try {
        const currentIdentity = fsSync.lstatSync(params.archivePath);
        cleanupReceipt = currentIdentity.isFile()
          ? {
              archivePath: params.archivePath,
              identity: currentIdentity,
            }
          : { archivePath: params.archivePath };
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          // Preserve the cleanup obligation even when the filesystem cannot
          // supply an identity until a later outer-cleanup attempt.
          cleanupReceipt = { archivePath: params.archivePath };
        }
      }
    }
    if (
      cleanupReceipt &&
      (!cleanupReceipt.identity ||
        !removePreparedBackupArchive(cleanupReceipt as PreparedBackupArchive))
    ) {
      params.onPartialArchive?.(cleanupReceipt);
    }
    if (cleanupReceipt && !cleanupReceipt.identity) {
      // The outer cleanup owns the retry because this scope cannot safely
      // unlink a pathname whose identity is temporarily unavailable.
      if (!params.onPartialArchive) {
        try {
          const currentIdentity = fsSync.lstatSync(cleanupReceipt.archivePath);
          if (currentIdentity.isFile()) {
            removePreparedBackupArchive({
              archivePath: cleanupReceipt.archivePath,
              identity: currentIdentity,
            });
          }
        } catch {
          // No outer owner was provided; preserve the original write error.
        }
      }
    }
    throw idleTimeoutError ?? err;
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}
