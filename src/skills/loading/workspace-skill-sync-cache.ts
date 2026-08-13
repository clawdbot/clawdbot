/**
 * Process-local published sandbox skill catalogs.
 *
 * The sync runtime writes the latest complete catalog here. Prompt readers must
 * bind that snapshot onto a per-run owner; they must not peek this cache as a
 * shared catalog, because concurrent sessions can publish different eligibility
 * snapshots into the same skills directory.
 */
import path from "node:path";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveUserPath } from "../../utils.js";
import type { SkillSnapshot, SkillUsagePath } from "../types.js";

type SyncedSkillsUsageCacheEntry = {
  manifestKey: string;
  skillUsagePaths: SkillUsagePath[];
  skillsSnapshot: SkillSnapshot;
};

const syncedSkillsUsageCache = new Map<string, SyncedSkillsUsageCacheEntry>();

export function resolveSyncedSkillsCacheKey(targetWorkspaceDir: string): string {
  return path.join(resolveUserPath(targetWorkspaceDir), "skills");
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

function dropSyncedSkillsUsageCacheForTests(targetWorkspaceDir: string): void {
  syncedSkillsUsageCache.delete(resolveSyncedSkillsCacheKey(targetWorkspaceDir));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.syncedSkillsCacheTestApi")] = {
    dropSyncedSkillsUsageCacheForTests,
  };
}
