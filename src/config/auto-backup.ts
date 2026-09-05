import fs from "node:fs/promises";
import path from "node:path";

export interface AutoBackupOptions {
  /** Directory where backups should be stored. Defaults to `.backups` subfolder in config directory. */
  backupDir?: string;
  /** Maximum number of backups to retain. Defaults to 10. */
  maxBackups?: number;
}

/**
 * Creates a timestamped backup of the specified configuration file
 * and rotates older backups to prevent uncontrolled disk usage.
 */
export async function createAutoBackup(
  configFilePath: string,
  options: AutoBackupOptions = {},
): Promise<string | null> {
  try {
    const exists = await fs
      .access(configFilePath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return null;
    }

    const resolvedConfigPath = path.resolve(configFilePath);
    const configDir = path.dirname(resolvedConfigPath);
    const configFileName = path.basename(resolvedConfigPath);

    const backupDir = options.backupDir
      ? path.resolve(options.backupDir)
      : path.join(configDir, ".backups");

    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFileName = `${configFileName}.${timestamp}.bak`;
    const backupFilePath = path.join(backupDir, backupFileName);

    await fs.copyFile(resolvedConfigPath, backupFilePath);

    const maxBackups = options.maxBackups ?? 10;
    await rotateBackups(backupDir, configFileName, maxBackups);

    return backupFilePath;
  } catch (error) {
    console.error("Failed to create automatic configuration backup:", error);
    return null;
  }
}

/**
 * Rotates existing backups in `backupDir` for `configFileName`,
 * keeping at most `maxBackups` newest files.
 */
export async function rotateBackups(
  backupDir: string,
  configFileName: string,
  maxBackups: number,
): Promise<void> {
  if (maxBackups <= 0) {
    return;
  }

  try {
    const files = await fs.readdir(backupDir);
    const prefix = `${configFileName}.`;
    const backupFiles = files.filter(
      (file) => file.startsWith(prefix) && file.endsWith(".bak"),
    );

    if (backupFiles.length <= maxBackups) {
      return;
    }

    const fileStats = await Promise.all(
      backupFiles.map(async (file) => {
        const filePath = path.join(backupDir, file);
        const stat = await fs.stat(filePath);
        return { filePath, mtime: stat.mtimeMs };
      }),
    );

    fileStats.sort((a, b) => b.mtime - a.mtime);

    const filesToRemove = fileStats.slice(maxBackups);
    for (const file of filesToRemove) {
      await fs.unlink(file.filePath).catch(() => {});
    }
  } catch (error) {
    console.error("Failed to rotate configuration backups:", error);
  }
}
