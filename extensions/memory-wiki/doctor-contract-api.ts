// Memory Wiki doctor contract owns legacy state cleanup and migrations.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  archiveLegacyStateSource,
  legacyStateFileExists,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS } from "./src/compiled-cache.js";
import {
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfiguredAgentIds,
  type MemoryWikiPluginConfig,
} from "./src/config.js";
import {
  countMemoryWikiImportRunStateRows,
  createMemoryWikiImportRunStateStore,
  listMemoryWikiImportRunRecords,
  MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES,
  MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE,
  readLegacyMemoryWikiImportRunRecords,
  resolveMemoryWikiImportRunsDir,
  type ChatGptImportRunRecord,
  writeMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  countLegacyImportedSourceSyncRows,
  migrateLegacyImportedSourceSyncKeys,
  pruneLegacyImportedSourceRows,
  translateLegacyImportedSourceSyncKey,
} from "./src/source-sync-legacy-migration.js";
import {
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  readLegacyMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  writeMemoryWikiSourceSyncState,
} from "./src/source-sync-state.js";
export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/config-compat.js";

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
    env: params.env,
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
  records: Array<Pick<ChatGptImportRunRecord, "createdPaths" | "updatedPaths">>,
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
  // Rekey raw legacy rows before importing JSON: the JSON migration's capacity
  // preflight only sees scoped rows until this pass runs, so importing first
  // could crash a full namespace mid-write and leave both migrations stuck.
  {
    id: "memory-wiki-source-sync-group-scoped-keys",
    label: "Memory Wiki source sync ownership keys",
    async detectLegacyState(params) {
      const previews: string[] = [];
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const legacyCount = await countLegacyImportedSourceSyncRows({
          vaultRoot,
          openKeyedStore: params.context.openPluginStateKeyedStore,
        });
        if (legacyCount > 0) {
          previews.push(
            `- Memory Wiki source sync ownership: ${legacyCount} legacy entries for ${vaultRoot} -> group-scoped keys`,
          );
        }
      }
      return previews.length > 0 ? { preview: previews } : null;
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const resolved = resolveMemoryWikiConfig(readConfiguredPluginConfig(params.config), {
        homedir: resolveHomeDir(params.env),
      });
      for (const vaultRoot of resolveConfiguredVaultRoots({
        config: params.config,
        env: params.env,
      })) {
        const result = await migrateLegacyImportedSourceSyncKeys({
          vaultRoot,
          openKeyedStore: params.context.openPluginStateKeyedStore,
          unsafeLocalConfiguredPaths: resolved.unsafeLocal.paths,
        });
        if (result.translatedCount > 0 || result.prunedCount > 0) {
          changes.push(
            `Migrated Memory Wiki source sync ownership -> group-scoped keys (${result.translatedCount} translated, ${result.prunedCount} stale pruned)`,
          );
        }
        for (const retainedKey of result.retainedKeys) {
          warnings.push(
            `Retained unrecognized Memory Wiki source sync row for ${vaultRoot}: ${retainedKey}`,
          );
        }
        for (const capacityKey of result.capacityRetainedKeys) {
          warnings.push(
            `Memory Wiki source sync host lacks atomic rekey and the namespace is full; retained legacy ownership row for ${vaultRoot}: ${capacityKey}. Update OpenClaw and rerun doctor to finish the migration.`,
          );
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
      const resolved = resolveMemoryWikiConfig(readConfiguredPluginConfig(params.config), {
        homedir: resolveHomeDir(params.env),
      });
      const unsafeLocalConfiguredRoots = resolved.unsafeLocal.paths.map((configuredPath) =>
        path.resolve(configuredPath),
      );
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
        // Translate legacy unscoped keys into group-scoped keys on import.
        // Entries whose recorded unsafe-local binding no longer matches a
        // configured root never enter the store unscoped: prune them through
        // the canonical salvage path here so one doctor pass converges (doctor
        // detects all plugin migrations before executing any).
        const translatedEntries: typeof state.entries = {};
        const staleRows: Array<{
          syncKey: string;
          entry: (typeof state.entries)[string];
        }> = [];
        for (const [syncKey, entry] of Object.entries(state.entries)) {
          const nextKey = translateLegacyImportedSourceSyncKey({
            entry,
            syncKey,
            unsafeLocalConfiguredRoots,
          });
          if (nextKey) {
            translatedEntries[nextKey] = entry;
          } else {
            staleRows.push({ syncKey, entry });
          }
        }
        const mergedEntries = {
          ...translatedEntries,
          ...existingState.entries,
        };
        const mergedCount = Object.keys(mergedEntries).length;
        // store.read hides unscoped legacy rows, but a full write preserves
        // them and they still occupy reject-new namespace capacity: count them
        // or this preflight passes and the write crashes mid-import.
        const unscopedRowCount = await countLegacyImportedSourceSyncRows({
          vaultRoot,
          openKeyedStore: params.context.openPluginStateKeyedStore,
        });
        const physicalCount = mergedCount + unscopedRowCount;
        if (physicalCount > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
          warnings.push(
            `Skipped Memory Wiki source-sync import for ${vaultRoot}: ${physicalCount} entries exceeds ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES}`,
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
        if (staleRows.length > 0) {
          const prunedCount = await pruneLegacyImportedSourceRows({
            vaultRoot,
            openKeyedStore: params.context.openPluginStateKeyedStore,
            rows: staleRows,
          });
          if (prunedCount > 0) {
            changes.push(
              `Pruned ${prunedCount} stale Memory Wiki source sync entries via Notes salvage`,
            );
          }
        }
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
