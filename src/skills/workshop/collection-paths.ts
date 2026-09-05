import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { logWarn } from "../../logger.js";

const BACKUP_REL_DIR = path.join("skill-workshop", "collection-backups");

export function resolveSkillCollectionBackupRoot(
  config: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(resolveAgentDir(config, agentId, env), BACKUP_REL_DIR);
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
