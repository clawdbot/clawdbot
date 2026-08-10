import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { resolveStateDir } from "../../config/paths.js";
import { sha256Hex } from "../../infra/crypto-digest.js";

const BACKUP_REL_DIR = path.join("skill-workshop", "collection-backups");

export function canonicalSkillCollectionWorkspace(workspaceDir: string): string {
  return canonicalizePath(path.resolve(workspaceDir));
}

export function resolveSkillCollectionBackupRoot(
  workspaceDir: string,
  env?: NodeJS.ProcessEnv,
): string {
  return path.join(
    resolveStateDir(env),
    BACKUP_REL_DIR,
    sha256Hex(canonicalSkillCollectionWorkspace(workspaceDir)).slice(0, 16),
  );
}
