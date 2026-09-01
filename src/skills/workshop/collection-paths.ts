import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { logWarn } from "../../logger.js";

const BACKUP_REL_DIR = path.join("skill-workshop", "collection-backups");

export function resolveSkillCollectionBackupRoot(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), BACKUP_REL_DIR);
}

export async function pruneOlderSkillCollectionBackups(
  backupRoot: string,
  keepId: string,
): Promise<void> {
  try {
    for (const entry of await fs.readdir(backupRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keepId) {
        await removePathWithinRoot({
          rootDir: backupRoot,
          relativePath: entry.name,
          recursive: true,
          force: true,
        });
      }
    }
  } catch (error) {
    logWarn(`skill-workshop: failed to prune older collection backups: ${String(error)}`);
  }
}
