/**
 * Process-local published sandbox skill catalogs.
 *
 * The sync runtime writes the latest complete generation here. Prompt readers
 * must bind that snapshot onto a per-run owner; they must not peek this cache
 * as a shared catalog, because concurrent sessions can publish different
 * eligibility snapshots into the same skills directory.
 */
import path from "node:path";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveUserPath } from "../../utils.js";
import type { SkillSnapshot, SkillUsagePath } from "../types.js";

type SyncedSkillsUsageCacheEntry = {
  generation?: number;
  manifestKey: string;
  skillUsagePaths: SkillUsagePath[];
  skillsSnapshot: SkillSnapshot;
};

const syncedSkillsUsageCache = new Map<string, SyncedSkillsUsageCacheEntry>();
const leasedGenerationCounts = new Map<string, Map<number, number>>();

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

export function leasePublishedSyncedSkillsGeneration(
  targetWorkspaceDir: string,
  generation: number,
): () => void {
  // Lease the advertised generation from the sync result, not the latest cache
  // entry. A queued publish can advance the cache after this result was
  // selected; pruning that older generation would delete advertised paths.
  const targetSkillsDir = resolveSyncedSkillsCacheKey(targetWorkspaceDir);
  if (!Number.isInteger(generation) || generation <= 0) {
    return () => {};
  }
  let counts = leasedGenerationCounts.get(targetSkillsDir);
  if (!counts) {
    counts = new Map();
    leasedGenerationCounts.set(targetSkillsDir, counts);
  }
  counts.set(generation, (counts.get(generation) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = leasedGenerationCounts.get(targetSkillsDir);
    if (!current) {
      return;
    }
    const remaining = (current.get(generation) ?? 0) - 1;
    if (remaining <= 0) {
      current.delete(generation);
    } else {
      current.set(generation, remaining);
    }
    if (current.size === 0) {
      leasedGenerationCounts.delete(targetSkillsDir);
    }
  };
}

export function collectRetainedSyncedSkillGenerations(params: {
  targetSkillsDir: string;
  currentGeneration: number;
  previousGeneration: number;
}): Set<number> {
  const retained = new Set<number>();
  if (params.currentGeneration > 0) {
    retained.add(params.currentGeneration);
  }
  if (params.previousGeneration > 0) {
    retained.add(params.previousGeneration);
  }
  const leased = leasedGenerationCounts.get(params.targetSkillsDir);
  if (!leased) {
    return retained;
  }
  for (const generation of leased.keys()) {
    retained.add(generation);
  }
  return retained;
}

function dropSyncedSkillsUsageCacheForTests(targetWorkspaceDir: string): void {
  const targetSkillsDir = resolveSyncedSkillsCacheKey(targetWorkspaceDir);
  syncedSkillsUsageCache.delete(targetSkillsDir);
  leasedGenerationCounts.delete(targetSkillsDir);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.syncedSkillsCacheTestApi")] = {
    dropSyncedSkillsUsageCacheForTests,
  };
}
