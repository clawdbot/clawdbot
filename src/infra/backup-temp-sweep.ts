// Reclaims backup temp directories that a hard-killed run left behind.
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

// A directory made by this (or a later) heartbeat-aware build carries this
// marker. A directory from a pre-upgrade build shares the exact same
// `mkdtemp` name shape but never writes it, because that build predates this
// file. Idle time alone cannot tell a genuinely abandoned new-format
// directory apart from a live pre-upgrade one still being written by `tar` —
// both look identical after the orphan window elapses. Requiring the marker
// makes the sweep opt in to only the format that can prove liveness at all;
// an unmarked directory is left alone regardless of age rather than guessed
// at, so an in-progress legacy backup can never be deleted out from under it.
const OWNER_MARKER_FILENAME = ".openclaw-backup-owner";

/**
 * Marks `directoryPath` as owned by the running backup until the returned stop
 * function is called. Idle time is the only signal the sweep has, and a long
 * `tar` pass only reads the staging directory, so without this a multi-hour run
 * ages past the orphan window and a second backup deletes its live source.
 * A hard-killed run stops refreshing, which is exactly what makes it reclaimable.
 */
export function keepBackupTempDirectoryAlive(directoryPath: string): () => void {
  const markerPath = path.join(directoryPath, OWNER_MARKER_FILENAME);
  // Written once, synchronously, immediately after this directory is created:
  // the marker's mere presence — not its timestamp — is what proves
  // ownership by heartbeat-aware code. See `OWNER_MARKER_FILENAME` above.
  try {
    writeFileSync(markerPath, "");
  } catch {}
  const timer = setInterval(() => {
    // Sync: a floating promise in a timer can outlive the directory and reject
    // after cleanup. One utimes syscall is cheaper than that failure mode.
    try {
      const now = new Date();
      utimesSync(directoryPath, now, now);
    } catch {}
  }, BACKUP_TEMP_KEEPALIVE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    // A normal finish (success or a handled error) must leave the directory
    // exactly as empty as it was before this call: cleanup only removes an
    // empty directory outright (`removeStagingDirectoryIfOwned`), and a
    // leftover marker would silently downgrade that to "preserved changed
    // directory" on every run. Only a hard kill skips this, which is exactly
    // when the marker must survive to prove ownership to the next sweep.
    try {
      unlinkSync(markerPath);
    } catch {}
  };
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
 * Removes directories in `directoryPath` whose name matches `entryPattern`,
 * that carry the `OWNER_MARKER_FILENAME` ownership marker, and that have been
 * idle past the orphan window. Live runs stay out of reach by refreshing
 * their own directories via `keepBackupTempDirectoryAlive`, so idle time
 * means abandoned rather than merely slow — but only for directories that
 * marker proves belong to heartbeat-aware code in the first place; see
 * `OWNER_MARKER_FILENAME` for why an unmarked directory is skipped outright.
 * Callers must still pass a pattern matching their own `mkdtemp` output
 * exactly rather than a bare prefix. Never throws: a failed sweep must not
 * take down the backup it was preparing for.
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
    const hasOwnerMarker = await fs.access(path.join(entryPath, OWNER_MARKER_FILENAME)).then(
      () => true,
      () => false,
    );
    if (!hasOwnerMarker) {
      continue;
    }
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
