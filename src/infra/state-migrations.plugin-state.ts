import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
} from "../plugin-state/plugin-state-store.js";
import {
  readPersistedInstalledPluginIndexSync,
  resolveLegacyInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndexSync,
} from "../plugins/installed-plugin-index-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { ensureMigrationDir, fileExists } from "./state-migrations.fs.js";
import {
  PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  archiveLegacyImportSource,
  archiveLegacyInstalledPluginIndex,
  archiveLegacyPluginStateSidecar,
  hasPendingSqliteSidecarArchive,
  isLegacyPluginStateRowExpired,
  legacyInstalledPluginIndexMatches,
  legacyPluginStateRowsMatch,
  mergeLegacyInstalledPluginIndexRecords,
  normalizeLegacySqliteInteger,
  readLegacyInstalledPluginIndex,
  readLegacyPluginStateSidecarRows,
  resolveLegacyPluginStateSidecarPath,
  type LegacyPluginStateSidecarRow,
} from "./state-migrations.storage.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type LegacyPluginStateImportDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

export async function migrateLegacyPluginStateSidecar(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyPluginStateSidecarPath(params.stateDir);
  if (!fileExists(sourcePath)) {
    const changes: string[] = [];
    const warnings: string[] = [];
    if (hasPendingSqliteSidecarArchive(sourcePath, PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES)) {
      archiveLegacyPluginStateSidecar({ sourcePath, changes, warnings });
    }
    return { changes, warnings };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  let rows: LegacyPluginStateSidecarRow[];
  try {
    rows = readLegacyPluginStateSidecarRows(sourcePath);
  } catch (err) {
    return {
      changes,
      warnings: [`Failed reading plugin-state sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  try {
    const conflictedKeys: string[] = [];
    const rowsToInsert: LegacyPluginStateSidecarRow[] = [];
    let imported = 0;
    let skippedExpired = 0;
    const now = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyPluginStateImportDatabase>(db);
        for (const row of rows) {
          executeSqliteQuerySync(
            db,
            stateDb
              .deleteFrom("plugin_state_entries")
              .where("plugin_id", "=", row.plugin_id)
              .where("namespace", "=", row.namespace)
              .where("entry_key", "=", row.entry_key)
              .where("expires_at", "is not", null)
              .where("expires_at", "<=", now),
          );
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            stateDb
              .selectFrom("plugin_state_entries")
              .select(["value_json", "created_at", "expires_at"])
              .where("plugin_id", "=", row.plugin_id)
              .where("namespace", "=", row.namespace)
              .where("entry_key", "=", row.entry_key),
          );
          const legacyExpired = isLegacyPluginStateRowExpired(row, now);
          if (existing) {
            if (!legacyPluginStateRowsMatch(existing, row)) {
              if (legacyExpired) {
                skippedExpired += 1;
              } else {
                conflictedKeys.push(`${row.plugin_id}/${row.namespace}/${row.entry_key}`);
              }
            }
            continue;
          }
          if (legacyExpired) {
            skippedExpired += 1;
            continue;
          }
          rowsToInsert.push(row);
        }
        for (const row of rowsToInsert) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: row.plugin_id,
                namespace: row.namespace,
                entry_key: row.entry_key,
                value_json: row.value_json,
                created_at: normalizeLegacySqliteInteger(row.created_at) ?? 0,
                expires_at: normalizeLegacySqliteInteger(row.expires_at),
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doNothing(),
              ),
          );
          imported += 1;
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} plugin-state sidecar ${imported === 1 ? "entry" : "entries"} → shared SQLite state`,
      );
    }
    if (conflictedKeys.length > 0) {
      return {
        changes,
        warnings: [
          `Left plugin-state sidecar in place because ${conflictedKeys.length} ${conflictedKeys.length === 1 ? "row" : "rows"} already existed in shared state: ${conflictedKeys[0]}`,
        ],
      };
    }
    if (skippedExpired > 0) {
      changes.push(
        `Dropped ${skippedExpired} expired plugin-state sidecar ${skippedExpired === 1 ? "entry" : "entries"}`,
      );
    }
  } catch (err) {
    return {
      changes,
      warnings: [`Failed migrating plugin-state sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  archiveLegacyPluginStateSidecar({ sourcePath, changes, warnings });
  return { changes, warnings };
}

export async function migrateLegacyInstalledPluginIndex(params: {
  stateDir: string;
}): Promise<MigrationMessages> {
  const sourcePath = resolveLegacyInstalledPluginIndexStorePath({ stateDir: params.stateDir });
  if (!fileExists(sourcePath)) {
    return { changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const legacy = readLegacyInstalledPluginIndex(sourcePath);
  if (!legacy) {
    return {
      changes,
      warnings: [`Left plugin install index in place because ${sourcePath} is invalid`],
    };
  }

  const storeOptions = { stateDir: params.stateDir };
  const current = readPersistedInstalledPluginIndexSync(storeOptions);
  if (current && !legacyInstalledPluginIndexMatches(current, legacy)) {
    const merged = mergeLegacyInstalledPluginIndexRecords(current, legacy);
    if (merged.addedCount > 0) {
      try {
        writePersistedInstalledPluginIndexSync(merged.merged, storeOptions);
        changes.push(
          `Merged ${merged.addedCount} legacy plugin install ${merged.addedCount === 1 ? "record" : "records"} → shared SQLite state`,
        );
      } catch (err) {
        return {
          changes,
          warnings: [`Failed merging plugin install index ${sourcePath}: ${String(err)}`],
        };
      }
    }
    if (merged.conflicts.length > 0) {
      // SQLite owns the install ledger; discovery can omit disabled or currently unloadable plugins.
      // Archive the retired JSON for recovery instead of blocking startup on conflicting metadata.
      archiveLegacyInstalledPluginIndex({ sourcePath, changes, warnings });
      return {
        changes,
        warnings,
        notices: [
          `Kept canonical shared SQLite plugin install metadata despite differing legacy records for: ${merged.conflicts.join(", ")}`,
        ],
      };
    }
  }

  if (!current) {
    try {
      writePersistedInstalledPluginIndexSync(legacy, storeOptions);
      const recordCount = Object.keys(legacy.installRecords).length;
      changes.push(
        `Migrated plugin install index ${recordCount} ${recordCount === 1 ? "record" : "records"} → shared SQLite state`,
      );
    } catch (err) {
      return {
        changes,
        warnings: [`Failed migrating plugin install index ${sourcePath}: ${String(err)}`],
      };
    }
  }

  archiveLegacyInstalledPluginIndex({ sourcePath, changes, warnings });
  return { changes, warnings };
}

function resolvePluginStateImportTargetKey(scopeKey: string, key: string): string {
  return scopeKey ? `${scopeKey}:${key}` : key;
}

function findMissingKey(expected: Set<string>, actual: Set<string>): string | undefined {
  for (const key of expected) {
    if (!actual.has(key)) {
      return key;
    }
  }
  return undefined;
}

async function withPluginStateImportEnv<T>(
  plan: Extract<ChannelLegacyStateMigrationPlan, { kind: "plugin-state-import" }>,
  run: () => Promise<T>,
): Promise<T> {
  if (!plan.stateDir) {
    return await run();
  }
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = plan.stateDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

export async function runLegacyMigrationPlans(
  plans: ChannelLegacyStateMigrationPlan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const plan of plans) {
    if (plan.kind === "plugin-state-import") {
      await withPluginStateImportEnv(plan, async () => {
        let storeEntries: Array<{ key: string; value: unknown }>;
        let pluginEntryCount;
        const store = createPluginStateKeyedStore<unknown>(plan.pluginId, {
          namespace: plan.namespace,
          maxEntries: plan.maxEntries,
          ...(plan.defaultTtlMs != null ? { defaultTtlMs: plan.defaultTtlMs } : {}),
        });
        try {
          storeEntries = await store.entries();
          pluginEntryCount = countPluginStateLiveEntries(plan.pluginId);
        } catch (err) {
          warnings.push(
            `Failed reading ${plan.label} plugin state before migration: ${String(err)}`,
          );
          return;
        }
        const existingKeys = new Set(storeEntries.map(({ key }) => key));
        const existingValuesByKey = new Map(storeEntries.map(({ key, value }) => [key, value]));
        const expectedKeys = new Set(existingKeys);
        let remainingCapacity = Math.max(0, plan.maxEntries - storeEntries.length);
        let entries: Awaited<ReturnType<typeof plan.readEntries>>;
        try {
          entries = await plan.readEntries();
        } catch (err) {
          warnings.push(`Failed reading ${plan.label} legacy source: ${String(err)}`);
          return;
        }
        const candidateEntries: Array<{
          key: string;
          targetKey: string;
          value: unknown;
          ttlMs?: number;
          existedBefore: boolean;
        }> = [];
        const failedTargetKeys = new Set<string>();
        let missingEntryCount = 0;
        for (const entry of entries) {
          const targetKey = resolvePluginStateImportTargetKey(plan.scopeKey, entry.key);
          const existingValue = existingValuesByKey.get(targetKey);
          if (existingKeys.has(targetKey)) {
            const shouldReplace =
              existingValue !== undefined &&
              (await plan.shouldReplaceExistingEntry?.({
                key: entry.key,
                existingValue,
                incomingValue: entry.value,
              }));
            if (shouldReplace) {
              candidateEntries.push({ ...entry, targetKey, existedBefore: true });
            }
            continue;
          }
          candidateEntries.push({ ...entry, targetKey, existedBefore: false });
          missingEntryCount++;
        }
        const pluginRemainingCapacity = Math.max(
          0,
          MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN - pluginEntryCount,
        );
        if (missingEntryCount > pluginRemainingCapacity) {
          warnings.push(
            `Skipped migrating ${plan.label} because plugin state has room for ${pluginRemainingCapacity} of ${missingEntryCount} missing entries; left legacy source in place`,
          );
          return;
        }
        let imported = 0;
        const changedKeys: string[] = [];
        for (const entry of candidateEntries) {
          if (!entry.existedBefore && remainingCapacity <= 0) {
            break;
          }
          try {
            await store.register(
              entry.targetKey,
              entry.value,
              entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
            );
            const nextExpectedKeys = new Set(expectedKeys);
            nextExpectedKeys.add(entry.targetKey);
            const liveKeys = new Set((await store.entries()).map(({ key }) => key));
            const missingKey = findMissingKey(nextExpectedKeys, liveKeys);
            if (missingKey) {
              for (const changedKey of changedKeys.toReversed()) {
                if (existingValuesByKey.has(changedKey)) {
                  await store.register(changedKey, existingValuesByKey.get(changedKey));
                } else {
                  await store.delete(changedKey);
                }
              }
              if (existingValuesByKey.has(entry.targetKey)) {
                await store.register(entry.targetKey, existingValuesByKey.get(entry.targetKey));
              } else {
                await store.delete(entry.targetKey);
              }
              warnings.push(
                `Stopped migrating ${plan.label} because plugin state cap evicted ${missingKey}; left legacy source in place`,
              );
              return;
            }
            expectedKeys.add(entry.targetKey);
            existingKeys.add(entry.targetKey);
            changedKeys.push(entry.targetKey);
            if (!entry.existedBefore) {
              remainingCapacity--;
            }
            imported++;
          } catch (err) {
            failedTargetKeys.add(entry.targetKey);
            warnings.push(`Failed migrating ${plan.label} entry ${entry.key}: ${String(err)}`);
          }
        }
        if (imported > 0) {
          changes.push(
            `Migrated ${imported} ${plan.label} ${imported === 1 ? "entry" : "entries"} → plugin state`,
          );
        }
        let cleanupKeys = existingKeys;
        if (plan.cleanupSource === "rename") {
          cleanupKeys = expectedKeys;
        }
        const allEntriesCovered =
          (entries.length === 0 && plan.cleanupWhenEmpty === true) ||
          (entries.length > 0 &&
            entries.every(
              ({ key }) =>
                cleanupKeys.has(resolvePluginStateImportTargetKey(plan.scopeKey, key)) &&
                !failedTargetKeys.has(resolvePluginStateImportTargetKey(plan.scopeKey, key)),
            ));
        if (allEntriesCovered && plan.cleanupSource === "rename" && fileExists(plan.sourcePath)) {
          archiveLegacyImportSource({
            sourcePath: plan.sourcePath,
            label: plan.label,
            changes,
            warnings,
          });
        }
        if (allEntriesCovered && plan.cleanupSource === "remove" && fileExists(plan.sourcePath)) {
          try {
            fs.unlinkSync(plan.sourcePath);
            changes.push(`Removed ${plan.label} legacy source (${plan.sourcePath})`);
          } catch (err) {
            warnings.push(`Failed removing ${plan.label} legacy source: ${String(err)}`);
          }
        }
        if (allEntriesCovered && plan.removeSource) {
          try {
            await plan.removeSource();
            changes.push(`Removed ${plan.label} legacy source (${plan.sourcePath})`);
          } catch (err) {
            warnings.push(`Failed removing ${plan.label} legacy source: ${String(err)}`);
          }
        }
      });
      continue;
    }
    if (fileExists(plan.targetPath)) {
      continue;
    }
    try {
      ensureMigrationDir(path.dirname(plan.targetPath));
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
    }
  }
  return { changes, warnings };
}
