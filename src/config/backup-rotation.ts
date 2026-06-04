// Rotates config backup files while preserving recent recovery points.
import path from "node:path";

const CONFIG_BACKUP_COUNT = 5;

interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
}

interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
}

/**
 * Advances the config `.bak` ring before a new primary backup is copied in.
 *
 * Missing slots are ignored so interrupted writes or first-run configs do not
 * block the next config write.
 */
export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    // best-effort
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      // best-effort
    });
  }
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    // best-effort
  });
}

/**
 * Sets owner-only permissions on every backup slot when chmod exists.
 *
 * Backups are copied on mixed filesystems, so copy mode preservation is not a
 * portable security guarantee.
 */
export async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    // best-effort
  });
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    await ioFs.chmod(`${backupBase}.${i}`, 0o600).catch(() => {
      // best-effort
    });
  }
}

/** Prunes stale `.bak.*` files that are outside the managed numbered ring. */
export async function cleanOrphanBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.readdir) {
    return;
  }
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const bakPrefix = `${base}.bak.`;

  const validSuffixes = new Set<string>();
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    validSuffixes.add(String(i));
  }

  let entries: string[];
  try {
    entries = await ioFs.readdir(dir);
  } catch {
    return; // best-effort
  }

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (validSuffixes.has(suffix)) {
      continue;
    }
    await ioFs.unlink(path.join(dir, entry)).catch(() => {
      // best-effort
    });
  }
}

interface PreUpdateSnapshotFs {
  writeFile: (
    path: string,
    content: string,
    options: { encoding: "utf-8"; mode: number; flag: "w" },
  ) => Promise<void>;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  existsSync: (path: string) => boolean;
}

const preUpdateConfigSnapshotsWritten = new Set<string>();

/**
 * Captures the first on-disk config state for an update attempt.
 *
 * The snapshot is outside the rotating `.bak` ring so repeated writes during
 * one process keep an operator-visible rollback point for the original file.
 */
export async function createPreUpdateConfigSnapshot(params: {
  configPath: string;
  fs: PreUpdateSnapshotFs;
}): Promise<void> {
  if (!params.fs.existsSync(params.configPath)) {
    return;
  }
  const snapshotKey = path.resolve(params.configPath);
  if (preUpdateConfigSnapshotsWritten.has(snapshotKey)) {
    return;
  }
  // Mark before I/O so a failed best-effort write cannot loop on every later write.
  preUpdateConfigSnapshotsWritten.add(snapshotKey);
  const snapshotPath = `${params.configPath}.pre-update`;
  try {
    const content = await params.fs.readFile(params.configPath, "utf-8");
    await params.fs.writeFile(snapshotPath, content, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "w",
    });
  } catch {
    // best-effort, do not block update
  }
}

/** Runs rotation, primary copy, permission hardening, then orphan pruning. */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs,
): Promise<void> {
  await rotateConfigBackups(configPath, ioFs);
  await ioFs.copyFile(configPath, `${configPath}.bak`).catch(() => {
    // best-effort
  });
  await hardenBackupPermissions(configPath, ioFs);
  await cleanOrphanBackups(configPath, ioFs);
}
