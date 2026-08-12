/**
 * Process-local published sandbox skill catalogs.
 *
 * Lives apart from the sync runtime so prompt readers can peek a complete
 * generation without importing the deferred sandbox copy path.
 */
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import type { SkillSnapshot, SkillUsagePath } from "../types.js";

export type SyncedSkillsUsageCacheEntry = {
  destinations: Map<string, string>;
  manifestKey: string;
  skillUsagePaths: SkillUsagePath[];
  skillsSnapshot: SkillSnapshot;
};

/** Process-local published catalog. Keyed by the target skills directory. */
export const syncedSkillsUsageCache = new Map<string, SyncedSkillsUsageCacheEntry>();

export function resolveSyncedSkillsCacheKey(targetWorkspaceDir: string): string {
  return path.join(resolveUserPath(targetWorkspaceDir), "skills");
}

export function peekPublishedSyncedSkillsSnapshot(
  targetWorkspaceDir: string,
): SkillSnapshot | undefined {
  return syncedSkillsUsageCache.get(resolveSyncedSkillsCacheKey(targetWorkspaceDir))
    ?.skillsSnapshot;
}
