import fs from "node:fs/promises";
import { sleep } from "../utils/sleep.js";

const BACKUP_TAR_MAX_ATTEMPTS = 3;
const BACKUP_TAR_BACKOFF_MS = [10_000, 20_000];

function isTarEofRaceError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EOF") {
    return true;
  }
  // Match only node-tar's grow/shrink race errors and truncated archive code.
  // Broad EOF matching also catches unrelated TLS failures and causes pointless retries.
  const message = (err as Error).message ?? "";
  return /(did not encounter expected|encountered unexpected) EOF|TAR_BAD_ARCHIVE/i.test(message);
}

type BackupTarRetryLogger = (message: string) => void;

function resolveBackupTarAttemptTempPath(tempArchivePath: string, attempt: number): string {
  return attempt === 1 ? tempArchivePath : `${tempArchivePath}.retry-${attempt}`;
}

export function resolveBackupTarAttemptTempPaths(tempArchivePath: string): string[] {
  return Array.from({ length: BACKUP_TAR_MAX_ATTEMPTS }, (_value, index) =>
    resolveBackupTarAttemptTempPath(tempArchivePath, index + 1),
  );
}

export async function removeBackupTempArchiveBestEffort(tempArchivePath: string): Promise<void> {
  await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
}

export async function writeTarArchiveWithRetry(params: {
  tempArchivePath: string;
  runTar: (tempArchivePath: string) => Promise<void>;
  log?: BackupTarRetryLogger;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<string> {
  const sleepFn = params.sleepMs ?? sleep;
  let lastErr: unknown;
  const attemptTempArchivePaths: string[] = [];
  for (let attempt = 1; attempt <= BACKUP_TAR_MAX_ATTEMPTS; attempt += 1) {
    const attemptTempArchivePath = resolveBackupTarAttemptTempPath(params.tempArchivePath, attempt);
    attemptTempArchivePaths.push(attemptTempArchivePath);
    try {
      await params.runTar(attemptTempArchivePath);
      for (const staleTempArchivePath of attemptTempArchivePaths.slice(0, -1)) {
        await removeBackupTempArchiveBestEffort(staleTempArchivePath);
      }
      return attemptTempArchivePath;
    } catch (err) {
      lastErr = err;
      if (!isTarEofRaceError(err) || attempt === BACKUP_TAR_MAX_ATTEMPTS) {
        for (const staleTempArchivePath of attemptTempArchivePaths) {
          await removeBackupTempArchiveBestEffort(staleTempArchivePath);
        }
        break;
      }
      try {
        await fs.rm(attemptTempArchivePath, { force: true });
      } catch (cleanupErr) {
        const code = (cleanupErr as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          params.log?.(
            `Backup archiver could not remove temp archive ${attemptTempArchivePath} between retries: ${code}. Continuing.`,
          );
        }
      }
      const backoff = BACKUP_TAR_BACKOFF_MS[attempt - 1] ?? 0;
      const offendingPath = (err as NodeJS.ErrnoException).path;
      params.log?.(
        `Backup archiver hit a live-write race${
          offendingPath ? ` on ${offendingPath}` : ""
        } (attempt ${attempt}/${BACKUP_TAR_MAX_ATTEMPTS}); retrying in ${Math.round(backoff / 1000)}s.`,
      );
      await sleepFn(backoff);
    }
  }
  const final = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const offendingPath = (lastErr as NodeJS.ErrnoException | undefined)?.path;
  const suffix = offendingPath
    ? ` (last offending path: ${offendingPath}, after ${BACKUP_TAR_MAX_ATTEMPTS} attempts)`
    : ` (after ${BACKUP_TAR_MAX_ATTEMPTS} attempts)`;
  throw new Error(`Backup archive write failed: ${final.message}${suffix}`, { cause: final });
}
