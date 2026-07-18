import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const BACKUP_ARCHIVE_IDLE_TIMEOUT_MS = 5 * 60_000;

type DestroyableArchiveStream = (NodeJS.ReadableStream | AsyncIterable<Uint8Array>) & {
  destroy(error?: Error): unknown;
};

export async function writeArchiveStreamToFile(params: {
  archivePath: string;
  archiveStream: DestroyableArchiveStream;
  idleTimeoutMs?: number;
}): Promise<void> {
  // Own both stream lifecycles so a tar read error closes the output handle
  // before retry cleanup touches the partial archive. Exclusive creation also
  // refuses a pre-existing path instead of following a symlink.
  const idleTimeoutMs = params.idleTimeoutMs ?? BACKUP_ARCHIVE_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
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

  armIdleTimer();
  try {
    await pipeline(
      params.archiveStream,
      progress,
      createWriteStream(params.archivePath, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal },
    );
  } catch (err) {
    throw idleTimeoutError ?? err;
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}
