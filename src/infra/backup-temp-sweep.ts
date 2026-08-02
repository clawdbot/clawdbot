// Reclaims backup temp directories that a hard-killed run left behind.
import { utimesSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Backup stages into temp directories that are removed by an in-process
// `finally`. SIGKILL, OOM, or a host reboot skips that block, and nothing
// else reaps the leftovers, so each interrupted run permanently leaks a
// full-size archive copy. Every owner sweeps its own artifacts before
// staging a new run.
const BACKUP_TEMP_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

// Derived so the heartbeat can never drift past the window it defends.
const BACKUP_TEMP_KEEPALIVE_INTERVAL_MS = BACKUP_TEMP_ORPHAN_MIN_AGE_MS / 48;

/**
 * Marks `directoryPath` as owned by the running backup until the returned stop
 * function is called. Idle time is the only signal the sweep has, and a long
 * `tar` pass only reads the staging directory, so without this a multi-hour run
 * ages past the orphan window and a second backup deletes its live source.
 * A hard-killed run stops refreshing, which is exactly what makes it reclaimable.
 */
export function keepBackupTempDirectoryAlive(directoryPath: string): () => void {
  const timer = setInterval(() => {
    // Sync: a floating promise in a timer can outlive the directory and reject
    // after cleanup. One utimes syscall is cheaper than that failure mode.
    try {
      const now = new Date();
      utimesSync(directoryPath, now, now);
    } catch {}
  }, BACKUP_TEMP_KEEPALIVE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A long tar write only touches the archive file, never its parent
// directory, so directory mtime alone would age out a live run and delete
// its staging directory mid-backup.
async function resolveNewestActivityMs(directoryPath: string): Promise<number | undefined> {
  const directoryStat = await fs.stat(directoryPath).catch(() => undefined);
  if (!directoryStat) {
    return undefined;
  }
  const childNames = await fs.readdir(directoryPath).catch(() => []);
  let newestMs = directoryStat.mtimeMs;
  for (const childName of childNames) {
    const childStat = await fs.stat(path.join(directoryPath, childName)).catch(() => undefined);
    if (childStat && childStat.mtimeMs > newestMs) {
      newestMs = childStat.mtimeMs;
    }
  }
  return newestMs;
}

/**
 * Removes directories in `directoryPath` whose name matches `entryPattern`
 * and that have been idle past the orphan window. Live runs stay out of reach
 * by refreshing their own directories via `keepBackupTempDirectoryAlive`, so
 * idle time means abandoned rather than merely slow. Callers must still pass a
 * pattern matching their own `mkdtemp` output exactly rather than a bare
 * prefix. Never throws: a failed sweep must not take down the backup it was
 * preparing for.
 */
export async function sweepStaleBackupTempDirectories(params: {
  directoryPath: string;
  entryPattern: RegExp;
  log?: (message: string) => void;
}): Promise<void> {
  const nowMs = Date.now();
  const entries = await fs
    .readdir(params.directoryPath, { withFileTypes: true })
    .catch(() => undefined);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, so a symlinked name that
    // matches the pattern is skipped instead of followed.
    if (!entry.isDirectory() || !params.entryPattern.test(entry.name)) {
      continue;
    }
    const entryPath = path.join(params.directoryPath, entry.name);
    const newestActivityMs = await resolveNewestActivityMs(entryPath);
    if (
      newestActivityMs === undefined ||
      nowMs - newestActivityMs < BACKUP_TEMP_ORPHAN_MIN_AGE_MS
    ) {
      continue;
    }
    const removed = await fs.rm(entryPath, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    if (removed) {
      params.log?.(`Backup removed stale temp directory ${entryPath}.`);
    }
  }
}
