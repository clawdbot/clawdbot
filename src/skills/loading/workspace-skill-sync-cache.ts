/**
 * Process-local published sandbox skill catalogs.
 *
 * Lives apart from the sync runtime so prompt readers can peek a complete
 * generation without importing the deferred sandbox copy path.
 */
import path from "node:path";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveUserPath } from "../../utils.js";
import type { SkillSnapshot, SkillUsagePath } from "../types.js";

type SyncedSkillsUsageCacheEntry = {
  destinations: Map<string, string>;
  manifestKey: string;
  skillUsagePaths: SkillUsagePath[];
  skillsSnapshot: SkillSnapshot;
};

const syncedSkillsUsageCache = new Map<string, SyncedSkillsUsageCacheEntry>();

export function resolveSyncedSkillsCacheKey(targetWorkspaceDir: string): string {
  return path.join(resolveUserPath(targetWorkspaceDir), "skills");
}

export function peekPublishedSyncedSkillsSnapshot(
  targetWorkspaceDir: string,
): SkillSnapshot | undefined {
  return readSyncedSkillsUsageCache(resolveSyncedSkillsCacheKey(targetWorkspaceDir))
    ?.skillsSnapshot;
}

export function readSyncedSkillsUsageCache(
  targetSkillsDir: string,
): SyncedSkillsUsageCacheEntry | undefined {
  return syncedSkillsUsageCache.get(targetSkillsDir);
}

export function writeSyncedSkillsUsageCache(
  targetSkillsDir: string,
  entry: SyncedSkillsUsageCacheEntry,
): void {
  syncedSkillsUsageCache.set(targetSkillsDir, entry);
}

export function pruneSyncedSkillsUsageCache(maxSize: number): void {
  pruneMapToMaxSize(syncedSkillsUsageCache, maxSize);
}
