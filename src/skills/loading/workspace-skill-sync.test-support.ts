import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSandboxFsBridgeFromResolver } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import { peekPublishedSyncedSkillsSnapshot } from "./workspace-skill-sync-cache.js";

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

export function createWorkspaceSkillSyncFixtures(label: string) {
  let fixtureRoot = "";
  let fixtureCount = 0;
  return {
    async setup(): Promise<void> {
      fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`)));
    },
    async cleanup(): Promise<void> {
      if (fixtureRoot) {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    async createCaseDir(prefix: string): Promise<string> {
      const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}
