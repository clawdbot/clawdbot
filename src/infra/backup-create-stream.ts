import fsSync, { createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sameFileIdentity } from "./fs-safe-advanced.js";

const BACKUP_ARCHIVE_IDLE_TIMEOUT_MS = 5 * 60_000;

type DestroyableArchiveStream = (NodeJS.ReadableStream | AsyncIterable<Uint8Array>) & {
  destroy(error?: Error): unknown;
};

type BackupTarEntryProgressStream = {
  flowing: boolean;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
};

type BackupArchiveProgress = {
  bytes?: number;
  entryPath?: string;
  phase: "entry" | "output" | "raw" | "traversal";
};

export type BackupArchiveCleanupReceipt = {
  archivePath: string;
  identity?: Stats;
};

export type PreparedBackupArchive = BackupArchiveCleanupReceipt & {
  identity: Stats;
};

export function observeBackupTarEntryProgress(
  entry: BackupTarEntryProgressStream,
  reportProgress: (bytes: number) => void,
): void {
  const wasFlowing = entry.flowing;
  entry.on("data", (chunk) => {
    reportProgress(typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length);
  });
  if (!wasFlowing) {
    // node-tar calls onWriteEntry before emitting the header. Adding a Minipass
    // data listener starts flow, so pause until Pack attaches its own consumer.
    entry.pause();
  }
}

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
  createArchiveStream: (
    reportProgress: (progress?: BackupArchiveProgress) => void,
  ) => DestroyableArchiveStream;
  onPartialArchive: (receipt: BackupArchiveCleanupReceipt) => void;
}): Promise<PreparedBackupArchive> {
  // Own both stream lifecycles so a tar read error closes the output handle
  // before retry cleanup touches the partial archive. Exclusive creation also
  // refuses a pre-existing path instead of following a symlink.
  const controller = new AbortController();
  let archiveStream: DestroyableArchiveStream | undefined;
  let openedIdentity: Stats | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimeoutError: Error | undefined;
  let lastEntryPath: string | undefined;
  let lastProgress: BackupArchiveProgress | undefined;
  let outputBytes = 0;
  let producerBytes = 0;
  let settled = false;
  const reportProgress = (progress?: BackupArchiveProgress) => {
    // One archive owns this watchdog. Late producer callbacks must not refresh
    // its timer after cleanup has completed.
    if (settled) {
      return;
    }
    if (progress) {
      lastProgress = progress;
      if (progress.entryPath) {
        lastEntryPath = progress.entryPath;
      }
      if (progress.bytes) {
        if (progress.phase === "output") {
          outputBytes += progress.bytes;
        } else if (progress.phase === "raw") {
          producerBytes += progress.bytes;
        }
      }
    }
    idleTimer =
      idleTimer?.refresh() ??
      setTimeout(() => {
        const entrySuffix = lastEntryPath
          ? `, entry=${JSON.stringify(sliceUtf16Safe(lastEntryPath, -512))}`
          : "";
        idleTimeoutError = new Error(
          `Backup archive write stalled: no progress observed for ${BACKUP_ARCHIVE_IDLE_TIMEOUT_MS}ms (phase=${lastProgress?.phase ?? "starting"}${entrySuffix}, rawBytes=${producerBytes}, outputBytes=${outputBytes})`,
        );
        archiveStream?.destroy(idleTimeoutError);
        controller.abort(idleTimeoutError);
      }, BACKUP_ARCHIVE_IDLE_TIMEOUT_MS);
  };
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      reportProgress({ phase: "output", bytes: chunk.length });
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
    archiveStream = params.createArchiveStream(reportProgress);
    const pipelinePromise = pipeline(archiveStream, progress, archiveWriteStream, {
      signal: controller.signal,
    });
    reportProgress();
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
      params.onPartialArchive(cleanupReceipt);
    }
    throw idleTimeoutError ?? err;
  } finally {
    settled = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}
