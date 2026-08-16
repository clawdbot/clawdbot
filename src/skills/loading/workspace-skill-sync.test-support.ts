import fs from "node:fs/promises";
import path from "node:path";
import { createSandboxFsBridgeFromResolver } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import type { SkillSnapshot } from "../types.js";
import {
  readSyncedSkillsUsageCache,
  resolveSyncedSkillsCacheKey,
} from "./workspace-skill-sync-cache.js";

type SyncedSkillsCacheTestApi = {
  dropSyncedSkillsUsageCacheForTests(targetWorkspaceDir: string): void;
};

function getSyncedSkillsCacheTestApi(): SyncedSkillsCacheTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.syncedSkillsCacheTestApi")
  ] as SyncedSkillsCacheTestApi;
}

export function peekPublishedSyncedSkillsSnapshot(
  targetWorkspaceDir: string,
): SkillSnapshot | undefined {
  return readSyncedSkillsUsageCache(resolveSyncedSkillsCacheKey(targetWorkspaceDir))
    ?.skillsSnapshot;
}

export function dropSyncedSkillsUsageCacheForTests(targetWorkspaceDir: string): void {
  getSyncedSkillsCacheTestApi().dropSyncedSkillsUsageCacheForTests(targetWorkspaceDir);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sortedSkillNames(names: Iterable<string>): string[] {
  return [...names].toSorted((left, right) => left.localeCompare(right, "en"));
}

export function publishedSkillFilePath(
  targetWorkspace: string,
  skillName: string,
): string | undefined {
  return peekPublishedSyncedSkillsSnapshot(targetWorkspace)?.resolvedSkills?.find(
    (skill) => skill.name === skillName,
  )?.filePath;
}

export function createMaterializedSkillsBridge(targetWorkspace: string) {
  const hostRoot = path.resolve(targetWorkspace);
  const containerRoot = "/workspace/.openclaw/sandbox-skills";
  return createSandboxFsBridgeFromResolver((filePath) => {
    const normalized = filePath.replaceAll("\\", "/");
    if (normalized !== containerRoot && !normalized.startsWith(`${containerRoot}/`)) {
      throw new Error(`Path escapes materialized skills mount: ${filePath}`);
    }
    const relativePath =
      normalized === containerRoot ? "" : normalized.slice(containerRoot.length + 1);
    return {
      hostPath: relativePath ? path.join(hostRoot, ...relativePath.split("/")) : hostRoot,
      relativePath,
      containerPath: normalized,
    };
  });
}

export function createWorkspaceSkillSyncFixtures(
  label: string,
  tempDirs: { make: (prefix: string) => string },
) {
  return {
    async createCaseDir(prefix: string): Promise<string> {
      return fs.realpath(tempDirs.make(`${label}-${prefix}-`));
    },
  };
}
