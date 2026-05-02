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
 * Harden file permissions on all .bak files in the rotation ring.
 * copyFile does not guarantee permission preservation on all platforms
 * (e.g. Windows, some NFS mounts), so we explicitly chmod each backup
 * to owner-only (0o600) to match the main config file.
 */
export async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  // Harden the primary .bak
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    // best-effort
  });
  // Harden numbered backups
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    await ioFs.chmod(`${backupBase}.${i}`, 0o600).catch(() => {
      // best-effort
    });
  }
}

/**
 * Remove orphan .bak files that fall outside the managed rotation ring.
 * These can accumulate from interrupted writes, manual copies, or PID-stamped
 * backups (e.g. openclaw.json.bak.1772352289, openclaw.json.bak.before-marketing).
 *
 * Only files matching `<configBasename>.bak.*` are considered; the primary
 * `.bak` and numbered `.bak.1` through `.bak.{N-1}` are preserved.
 */
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

  // Build the set of valid numbered suffixes: "1", "2", ..., "{N-1}"
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
    // This is an orphan — remove it
    await ioFs.unlink(path.join(dir, entry)).catch(() => {
      // best-effort
    });
  }
}

/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: rotate ring -> create new .bak -> harden modes -> prune orphan .bak.* files.
 */
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
