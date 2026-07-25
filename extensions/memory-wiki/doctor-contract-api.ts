// Memory Wiki doctor contract owns legacy state cleanup and migrations.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  archiveLegacyStateSource,
  legacyStateFileExists,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS } from "./src/compiled-cache.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfiguredAgentIds,
  type MemoryWikiPluginConfig,
} from "./src/config.js";
export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/config-compat.js";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  countMemoryWikiImportRunStateRows,
  createMemoryWikiImportRunStateStore,
  listMemoryWikiImportRunRecords,
  MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES,
  MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE,
  readLegacyMemoryWikiImportRunRecords,
  resolveMemoryWikiImportRunsDir,
  writeMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  readLegacyMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  writeMemoryWikiSourceSyncState,
} from "./src/source-sync-state.js";

function resolveHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

function isMissingPathError(error: unknown): boolean {
  return (
    (error instanceof FsSafeError && error.code === "not-found") ||
    (isRecord(error) && error.code === "ENOENT")
  );
}

async function safeLegacyCacheFileExists(
  vaultRoot: Awaited<ReturnType<typeof fsRoot>>,
  relativePath: string,
): Promise<boolean> {
  try {
    const stat = await vaultRoot.stat(relativePath);
    return stat.isFile;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof FsSafeError) {
      return false;
    }
    throw error;
  }
}

async function openExistingVaultRoot(vaultRoot: string) {
  try {
    return await fsRoot(vaultRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function readConfiguredPluginConfig(config: OpenClawConfig): MemoryWikiPluginConfig | undefined {
  const entries = config.plugins?.entries;
  const pluginEntry = isRecord(entries) ? entries["memory-wiki"] : undefined;
  if (!isRecord(pluginEntry) || !isRecord(pluginEntry.config)) {
    return undefined;
  }
  return pluginEntry.config as MemoryWikiPluginConfig;
}

function resolveConfiguredVaultRoots(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string[] {
  const homeDir = resolveHomeDir(params.env);
  const resolved = resolveMemoryWikiConfig(readConfiguredPluginConfig(params.config), {
    homedir: homeDir,
  });
  if (resolved.vault.scope === "global") {
    return [resolved.vault.path];
  }
  return resolveMemoryWikiConfiguredAgentIds(params.config).map(
    (agentId) =>
      resolveMemoryWikiAgentConfig({
        config: resolved,
        appConfig: params.config,
        agentId,
      }).vault.path,
  );
}

async function archiveLegacyImportRunRecords(params: {
  vaultRoot: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const importRunsDir = resolveMemoryWikiImportRunsDir(params.vaultRoot);
  const entries = await fs
    .readdir(importRunsDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    await archiveLegacyStateSource({
      filePath: path.join(importRunsDir, entry.name),
      label: "Memory Wiki import-run",
      changes: params.changes,
      warnings: params.warnings,
    });
  }
}

function countImportRunStateRows(
  records: Array<{ createdPaths: string[]; updatedPaths: unknown[] }>,
): number {
  return records.reduce(
    (total, record) => total + 1 + record.createdPaths.length + record.updatedPaths.length,
    0,
  );
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-wiki-compiled-cache-file-cleanup",
    label: "Memory Wiki compiled cache files",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const root = await openExistingVaultRoot(vaultRoot);
        if (!root) {
          continue;
        }
        const stalePaths = (
          await Promise.all(
            LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS.map(async (relativePath) => {
              const filePath = path.join(vaultRoot, relativePath);
              return (await safeLegacyCacheFileExists(root, relativePath)) ? filePath : null;
            }),
          )
        ).filter((filePath): filePath is string => Boolean(filePath));
        for (const filePath of stalePaths) {
          previews.push(`- Remove rebuildable Memory Wiki compiled cache: ${filePath}`);
        }
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const root = await openExistingVaultRoot(vaultRoot);
        if (!root) {
          continue;
        }
        for (const relativePath of LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS) {
          const filePath = path.join(vaultRoot, relativePath);
          if (!(await safeLegacyCacheFileExists(root, relativePath))) {
            continue;
          }
          try {
            await root.remove(relativePath);
            changes.push(`Removed rebuildable Memory Wiki compiled cache: ${filePath}`);
          } catch (error) {
            if (!isMissingPathError(error)) {
              warnings.push(
                `Failed removing rebuildable Memory Wiki compiled cache ${filePath}: ${String(error)}`,
              );
            }
          }
        }
      }
      return { changes, warnings };
    },
  },
  {
    id: "memory-wiki-source-sync-json-to-plugin-state",
    label: "Memory Wiki source sync state",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const filePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
        const state = await readLegacyMemoryWikiSourceSyncState(vaultRoot);
        const count = Object.keys(state.entries).length;
        if (count === 0 || !(await legacyStateFileExists(filePath))) {
          continue;
        }
        previews.push(
          `- Memory Wiki source sync: ${filePath} -> plugin state (${MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE}, ${count} entries)`,
        );
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const filePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
        if (!(await legacyStateFileExists(filePath))) {
          continue;
        }
        const state = await readLegacyMemoryWikiSourceSyncState(vaultRoot);
        const count = Object.keys(state.entries).length;
        if (count === 0) {
          continue;
        }
        const existingState = await store.read(vaultRoot);
        const mergedEntries = {
          ...state.entries,
          ...existingState.entries,
        };
        const mergedCount = Object.keys(mergedEntries).length;
        if (mergedCount > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
          warnings.push(
            `Skipped Memory Wiki source-sync import for ${vaultRoot}: ${mergedCount} entries exceeds ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES}`,
          );
          continue;
        }
        await writeMemoryWikiSourceSyncState(
          vaultRoot,
          { version: 1, entries: mergedEntries },
          store,
        );
        const existingCount = Object.keys(existingState.entries).length;
        const importedCount = mergedCount - existingCount;
        changes.push(
          `Migrated Memory Wiki source sync -> plugin state (${importedCount} imported, ${existingCount} existing)`,
        );
        await archiveLegacyStateSource({
          filePath,
          label: "Memory Wiki source-sync",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "memory-wiki-import-runs-json-to-plugin-state",
    label: "Memory Wiki import run records",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const records = await readLegacyMemoryWikiImportRunRecords(vaultRoot);
        if (records.length === 0) {
          continue;
        }
        previews.push(
          `- Memory Wiki import runs: ${resolveMemoryWikiImportRunsDir(vaultRoot)}/*.json -> plugin state (${MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE}, ${records.length} records)`,
        );
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const records = await readLegacyMemoryWikiImportRunRecords(vaultRoot);
        if (records.length === 0) {
          continue;
        }
        const existingRecords = await listMemoryWikiImportRunRecords(vaultRoot, store);
        const existingRunIds = new Set(existingRecords.map((record) => record.runId));
        const importedRecords = records.filter((record) => !existingRunIds.has(record.runId));
        const nextRowCount =
          (await countMemoryWikiImportRunStateRows(store)) +
          countImportRunStateRows(importedRecords);
        if (nextRowCount > MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES) {
          warnings.push(
            `Skipped Memory Wiki import-run import for ${vaultRoot}: ${nextRowCount} state rows exceeds ${MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES}`,
          );
          continue;
        }
        let importedCount = 0;
        for (const record of importedRecords) {
          await writeMemoryWikiImportRunRecord(vaultRoot, record, store);
          importedCount += 1;
        }
        changes.push(
          `Migrated Memory Wiki import runs -> plugin state (${importedCount} imported, ${existingRunIds.size} existing)`,
        );
        await archiveLegacyImportRunRecords({ vaultRoot, changes, warnings });
      }
      return { changes, warnings };
    },
  },
];
