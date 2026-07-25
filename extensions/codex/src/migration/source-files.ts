// Codex migration source file discovery stays filesystem-only and bounded.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { exists, isDirectory, readJsonObject } from "./helpers.js";

const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2000;

export type CodexSkillSource = {
  name: string;
  source: string;
  sourceLabel: string;
};

export type CodexPluginMigrationBlockCode =
  | "plugin_disabled"
  | "codex_subscription_required"
  | "codex_account_unavailable"
  | "plugin_read_unavailable"
  | "app_inventory_unavailable"
  | "app_inaccessible"
  | "app_disabled"
  | "app_missing";

export type CodexPluginMigrationAppFact = {
  id: string;
  name: string;
  needsAuth?: boolean;
  isAccessible?: boolean;
  isEnabled?: boolean;
};

type CodexPluginMigrationBlock = {
  code: CodexPluginMigrationBlockCode;
  apps?: CodexPluginMigrationAppFact[];
  error?: string;
};

export type CodexPluginSource = {
  name: string;
  source: string;
  sourceKind: "app-server" | "cache";
  migratable: boolean;
  manifestPath?: string;
  marketplaceName?: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
  pluginName?: string;
  installed?: boolean;
  enabled?: boolean;
  apps?: CodexPluginMigrationAppFact[];
  migrationBlock?: CodexPluginMigrationBlock;
  message?: string;
};

export type CodexMemorySource = {
  id: string;
  label: string;
  path: string;
};

async function safeReadDir(dir: string): Promise<Dirent[]> {
  return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

export async function discoverSkillDirs(params: {
  root: string | undefined;
  sourceLabel: string;
  excludeSystem?: boolean;
}): Promise<CodexSkillSource[]> {
  if (!params.root || !(await isDirectory(params.root))) {
    return [];
  }
  const discovered: CodexSkillSource[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const name = path.basename(dir);
    if (params.excludeSystem && depth === 1 && name === ".system") {
      return;
    }
    if (await exists(path.join(dir, SKILL_FILENAME))) {
      discovered.push({ name, source: dir, sourceLabel: params.sourceLabel });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await visit(params.root, 0);
  return discovered;
}

export async function discoverPluginDirs(codexHome: string): Promise<CodexPluginSource[]> {
  const root = path.join(codexHome, "plugins", "cache");
  if (!(await isDirectory(root))) {
    return [];
  }
  const discovered = new Map<string, CodexPluginSource>();
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
    if (await exists(manifestPath)) {
      const manifest = await readJsonObject(manifestPath);
      const manifestName = typeof manifest.name === "string" ? manifest.name.trim() : "";
      discovered.set(dir, {
        name: manifestName || path.basename(dir),
        source: dir,
        manifestPath,
        sourceKind: "cache",
        migratable: false,
        message:
          "Cached Codex plugin bundle found. Review manually unless the plugin is also installed in the source Codex app-server inventory",
      });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return [...discovered.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}

async function discoverCodexMemoryFile(
  candidate: CodexMemorySource,
): Promise<CodexMemorySource | undefined> {
  try {
    const stat = await fs.lstat(candidate.path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Codex memory source must not be a symbolic link: ${candidate.path}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Codex memory source must be a regular file: ${candidate.path}`);
    }
    return candidate;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function discoverCodexMemorySources(codexHome: string): Promise<{
  memoriesDir?: string;
  memoryFiles: CodexMemorySource[];
}> {
  const memoriesDir = path.join(codexHome, "memories");
  const memoryFiles = (
    await Promise.all(
      [
        { id: "memory:codex:MEMORY.md", label: "Codex consolidated memory", name: "MEMORY.md" },
        {
          id: "memory:codex:memory_summary.md",
          label: "Codex memory summary",
          name: "memory_summary.md",
        },
      ].map(
        async (candidate) =>
          await discoverCodexMemoryFile({
            id: candidate.id,
            label: candidate.label,
            path: path.join(memoriesDir, candidate.name),
          }),
      ),
    )
  ).filter((entry): entry is CodexMemorySource => entry !== undefined);
  return {
    ...((await isDirectory(memoriesDir)) ? { memoriesDir } : {}),
    memoryFiles,
  };
}
