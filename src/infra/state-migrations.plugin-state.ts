import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  registerMigratedPluginStateEntry,
  resolveMaxPluginStateEntriesPerPlugin,
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
              const existingCreatedAt = normalizeLegacySqliteInteger(existing.created_at) ?? 0;
              const rowCreatedAt = normalizeLegacySqliteInteger(row.created_at) ?? 0;
              if (existingCreatedAt > rowCreatedAt) {
                // Canonical row is strictly newer — migration already satisfied
              } else if (legacyExpired) {
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
          `Left plugin-state sidecar in place because ${conflictedKeys.length} ${conflictedKeys.length === 1 ? "row differs" : "rows differ"} from shared state without a newer canonical timestamp. First key: ${conflictedKeys[0]}`,
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

function compareImportEntriesNewestFirst(
  a: { ttlMs?: number; timestamp?: number },
  b: { ttlMs?: number; timestamp?: number },
): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined) {
    return b.timestamp - a.timestamp;
  }
  // Remaining TTL is monotone with recency for fixed-TTL caches.
  if (a.ttlMs !== undefined && b.ttlMs !== undefined) {
    return b.ttlMs - a.ttlMs;
  }
  return 0;
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
        let storeEntries: Array<{ key: string; value: unknown; createdAt: number }>;
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
        const existingCreatedAtByKey = new Map(
          storeEntries.map(({ key, createdAt }) => [key, createdAt]),
        );
        const expectedKeys = new Set(existingKeys);
        const namespaceRemainingCapacity = Math.max(0, plan.maxEntries - storeEntries.length);
        let entries: Awaited<ReturnType<typeof plan.readEntries>>;
        try {
          entries = await plan.readEntries();
        } catch (err) {
          warnings.push(`Failed reading ${plan.label} legacy source: ${String(err)}`);
          return;
        }
        type CandidateEntry = {
          key: string;
          targetKey: string;
          value: unknown;
          ttlMs?: number;
          timestamp?: number;
          existedBefore: boolean;
        };
        const replacementEntries: CandidateEntry[] = [];
        let newEntries: CandidateEntry[] = [];
        const failedTargetKeys = new Set<string>();
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
              replacementEntries.push({ ...entry, targetKey, existedBefore: true });
            }
            continue;
          }
          newEntries.push({ ...entry, targetKey, existedBefore: false });
        }
        const missingEntryCount = newEntries.length;
        const pluginRemainingCapacity = Math.max(
          0,
          resolveMaxPluginStateEntriesPerPlugin() - pluginEntryCount,
        );
        // Capacity limits must never turn the import into a permanent no-op: import the
        // newest entries that fit and defer the rest to a later startup (the legacy source
        // stays in place until every entry is covered).
        const importBudget = Math.min(namespaceRemainingCapacity, pluginRemainingCapacity);
        if (missingEntryCount > importBudget) {
          newEntries = newEntries.toSorted(compareImportEntriesNewestFirst).slice(0, importBudget);
          const constraint =
            namespaceRemainingCapacity <= pluginRemainingCapacity
              ? `plugin state namespace ${plan.namespace} has room for ${namespaceRemainingCapacity}`
              : `plugin state has room for ${pluginRemainingCapacity}`;
          warnings.push(
            newEntries.length > 0
              ? `Partially migrating ${plan.label} because ${constraint} of ${missingEntryCount} missing entries; importing the newest ${newEntries.length} and deferring the rest in the legacy source`
              : `Deferring ${plan.label} migration because ${constraint} of ${missingEntryCount} missing entries; left legacy source in place to retry when capacity frees`,
          );
        }
        // Eviction removes the smallest created_at first, so imported rows must
        // keep their legacy creation time; writing them through the normal
        // register path would stamp them "now" and let later live writes evict
        // fresher pre-existing rows before the migrated ones.
        const registerPreservingCreatedAt = async (params: {
          key: string;
          value: unknown;
          ttlMs?: number;
          createdAtMs?: number;
        }) => {
          if (
            params.createdAtMs === undefined ||
            !Number.isFinite(params.createdAtMs) ||
            params.createdAtMs < 0
          ) {
            await store.register(
              params.key,
              params.value,
              params.ttlMs != null ? { ttlMs: params.ttlMs } : undefined,
            );
            return;
          }
          registerMigratedPluginStateEntry({
            pluginId: plan.pluginId,
            namespace: plan.namespace,
            maxEntries: plan.maxEntries,
            ...(plan.defaultTtlMs != null ? { defaultTtlMs: plan.defaultTtlMs } : {}),
            key: params.key,
            value: params.value,
            ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
            createdAtMs: params.createdAtMs,
          });
        };
        const restoreExistingEntry = async (key: string) => {
          await registerPreservingCreatedAt({
            key,
            value: existingValuesByKey.get(key),
            createdAtMs: existingCreatedAtByKey.get(key),
          });
        };
        let imported = 0;
        const changedKeys = new Set<string>();
        for (const entry of [...replacementEntries, ...newEntries]) {
          try {
            await registerPreservingCreatedAt({
              key: entry.targetKey,
              value: entry.value,
              ...(entry.ttlMs != null ? { ttlMs: entry.ttlMs } : {}),
              ...(entry.timestamp !== undefined ? { createdAtMs: entry.timestamp } : {}),
            });
            const nextExpectedKeys = new Set(expectedKeys);
            nextExpectedKeys.add(entry.targetKey);
            const liveKeys = new Set((await store.entries()).map(({ key }) => key));
            const missingKey = findMissingKey(nextExpectedKeys, liveKeys);
            if (missingKey) {
              // A concurrent write pushed the store over a cap and evicted a row. Roll back
              // only the entry whose write triggered the eviction, restore the evicted live
              // row when we still hold its value, and keep everything imported so far —
              // deferred entries stay in the legacy source for the next startup.
              if (existingValuesByKey.has(entry.targetKey)) {
                await restoreExistingEntry(entry.targetKey);
              } else {
                await store.delete(entry.targetKey);
              }
              if (changedKeys.has(missingKey)) {
                changedKeys.delete(missingKey);
                expectedKeys.delete(missingKey);
                existingKeys.delete(missingKey);
                imported = Math.max(0, imported - 1);
              } else if (existingValuesByKey.has(missingKey)) {
                try {
                  await restoreExistingEntry(missingKey);
                } catch (restoreErr) {
                  warnings.push(
                    `Failed restoring ${plan.label} entry ${missingKey} after cap eviction: ${String(restoreErr)}`,
                  );
                }
              }
              warnings.push(
                `Paused migrating ${plan.label} because plugin state cap evicted ${missingKey}; imported ${imported} of ${missingEntryCount} missing entries and deferred the rest in the legacy source`,
              );
              break;
            }
            expectedKeys.add(entry.targetKey);
            existingKeys.add(entry.targetKey);
            changedKeys.add(entry.targetKey);
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
