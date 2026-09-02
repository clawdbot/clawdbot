/** Writes, restores, and refreshes the installed plugin index in the state database. */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createPluginInstallRecordMap,
  inspectPluginInstallRecordMap,
  parsePluginInstallRecord,
  serializePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isGatewayPluginMetadataSnapshotActive } from "./current-plugin-metadata-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { resolveCompatRegistryVersion } from "./installed-plugin-index-policy.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  INSTALLED_PLUGIN_INDEX_STATE_KEY,
  parseInstalledPluginIndexSqliteRow,
  readInstalledPluginIndexRow,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
  type PersistedInstalledPluginIndexValue,
} from "./installed-plugin-index-store.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  hasInstalledPluginIndexWorkspaceScopeMismatch,
  hasMissingConfigPathActivationMetadata,
  INSTALLED_PLUGIN_INDEX_WARNING,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  resolveInstalledPluginIndexPolicyHash,
  refreshInstalledPluginIndex,
  type InstalledPluginIndex,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { hasMissingInstalledPluginOwnerMetadata } from "./installed-plugin-package-ownership.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

export type InstalledPluginIndexWriteLease = {
  assertOwnedInTransaction(database: DatabaseSync): void;
};

export type InstalledPluginIndexWriteReceipt = {
  previous: InstalledPluginIndex | null;
  revision: number;
};

function assertWritableInstalledPluginIndexStoreOptions(
  options: InstalledPluginIndexStoreOptions,
): void {
  if (options.filePath?.endsWith(".json")) {
    throw new Error(
      "Explicit JSON installed plugin index paths are retired. Use the shared SQLite state DB or run openclaw doctor --fix to migrate legacy plugins/installs.json.",
    );
  }
}

function preparePersistedInstalledPluginIndex(index: InstalledPluginIndex): InstalledPluginIndex {
  const installRecords = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, rawRecord] of Object.entries(index.installRecords)) {
    const record = parsePluginInstallRecord(rawRecord);
    if (!record) {
      throw new Error("Invalid plugin install record");
    }
    setPluginInstallRecordMapEntry(installRecords, pluginId, record);
  }
  return {
    ...index,
    warning: INSTALLED_PLUGIN_INDEX_WARNING,
    installRecords,
  };
}

function resolveNextInstalledPluginIndexRevision(current: number | null): number {
  // Revisions fence rollback across processes, so same-millisecond writes must
  // still receive distinct values.
  return Math.max(Date.now(), (current ?? 0) + 1);
}

function writePersistedInstalledPluginIndexRow(
  database: DatabaseSync,
  index: InstalledPluginIndex,
  revision: number,
): void {
  const persistedIndex = {
    version: index.version,
    warning: index.warning ?? INSTALLED_PLUGIN_INDEX_WARNING,
    hostContractVersion: index.hostContractVersion,
    compatRegistryVersion: index.compatRegistryVersion,
    migrationVersion: index.migrationVersion,
    policyHash: index.policyHash,
    generatedAtMs: index.generatedAtMs,
    ...(index.workspaceDir !== undefined ? { workspaceDir: index.workspaceDir } : {}),
    ...(index.refreshReason ? { refreshReason: index.refreshReason } : {}),
    // SAFETY: canonical serializer output re-parsed for byte-order-stable embedding.
    installRecords: JSON.parse(serializePluginInstallRecordMap(index.installRecords)) as unknown,
    plugins: index.plugins.map((plugin) => {
      const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
      return {
        ...plugin,
        ...(installOwner ? { installOwner } : {}),
        ...(isInstalledPluginIndexInstallOwnerAmbiguous(plugin)
          ? { installOwnerAmbiguous: true }
          : {}),
      };
    }),
    diagnostics: index.diagnostics,
  };
  const valueJson = JSON.stringify({
    revision,
    index: persistedIndex,
  } satisfies PersistedInstalledPluginIndexValue);
  database
    .prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at_ms = excluded.updated_at_ms
      `,
    )
    .run(INSTALLED_PLUGIN_INDEX_STATE_KEY, valueJson, revision);
}

function writePersistedInstalledPluginIndexToSqlite(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
  lease?: InstalledPluginIndexWriteLease,
): InstalledPluginIndexWriteReceipt {
  assertWritableInstalledPluginIndexStoreOptions(options);
  const persisted = preparePersistedInstalledPluginIndex(index);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const previousRow = readInstalledPluginIndexRow(db);
    if (previousRow) {
      // SAFETY: field probe on the stored value; inspectPluginInstallRecordMap validates it.
      const previousInstallRecords = (previousRow.index as { installRecords?: unknown } | null)
        ?.installRecords;
      if (
        previousInstallRecords === undefined ||
        inspectPluginInstallRecordMap(previousInstallRecords).status === "invalid"
      ) {
        throw new Error(
          "Persisted plugin install records are invalid. Repair the state before writing plugin installation metadata.",
        );
      }
    }
    lease?.assertOwnedInTransaction(db);
    const revision = resolveNextInstalledPluginIndexRevision(
      previousRow ? previousRow.revision : null,
    );
    writePersistedInstalledPluginIndexRow(db, persisted, revision);
    return {
      previous: parseInstalledPluginIndexSqliteRow(previousRow),
      revision,
    };
  }, resolveInstalledPluginIndexStateDatabaseOptions(options));
}

function clearPersistedInstalledPluginIndexCaches(): void {
  // Install transactions change the next boot's inventory, never the running Gateway's graph.
  if (!isGatewayPluginMetadataSnapshotActive()) {
    clearPluginMetadataLifecycleCaches();
  }
  clearLoadInstalledPluginIndexInstallRecordsCache();
}

export async function writePersistedInstalledPluginIndex(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): Promise<string> {
  return writePersistedInstalledPluginIndexSync(index, options);
}

/** Restore a snapshot only while the caller's tentative write is still current. */
export async function restorePersistedInstalledPluginIndexIfCurrent(
  index: InstalledPluginIndex | null,
  expectedRevision: number,
  options: InstalledPluginIndexStoreOptions & {
    lease: InstalledPluginIndexWriteLease;
  },
): Promise<boolean> {
  const { lease, ...storeOptions } = options;
  assertWritableInstalledPluginIndexStoreOptions(storeOptions);
  if (!existsSync(resolveInstalledPluginIndexStorePath(storeOptions))) {
    return false;
  }
  const restored = runOpenClawStateWriteTransaction(({ db }) => {
    lease.assertOwnedInTransaction(db);
    const currentRow = readInstalledPluginIndexRow(db);
    const currentRevision = currentRow ? currentRow.revision : null;
    if (currentRevision !== expectedRevision) {
      return false;
    }
    if (index) {
      writePersistedInstalledPluginIndexRow(
        db,
        preparePersistedInstalledPluginIndex(index),
        resolveNextInstalledPluginIndexRevision(currentRevision),
      );
    } else {
      db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run(
        INSTALLED_PLUGIN_INDEX_STATE_KEY,
      );
    }
    return true;
  }, resolveInstalledPluginIndexStateDatabaseOptions(storeOptions));
  // A mismatched revision means another process committed, which also makes
  // this process's cached metadata stale.
  clearPersistedInstalledPluginIndexCaches();
  return restored;
}

export function writePersistedInstalledPluginIndexSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): string {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  writePersistedInstalledPluginIndexToSqlite(index, options);
  clearPersistedInstalledPluginIndexCaches();
  return filePath;
}

export function writePersistedInstalledPluginIndexWithLeaseSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions & {
    lease: InstalledPluginIndexWriteLease;
  },
): string {
  const { lease, ...storeOptions } = options;
  const filePath = resolveInstalledPluginIndexStorePath(storeOptions);
  writePersistedInstalledPluginIndexToSqlite(index, storeOptions, lease);
  clearPersistedInstalledPluginIndexCaches();
  return filePath;
}

function hasCompletePolicyRefreshProjection(
  persisted: InstalledPluginIndex,
  policyPluginIds: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const pluginIds = new Set(persisted.plugins.map((plugin) => plugin.pluginId));
  if (policyPluginIds?.some((pluginId) => !pluginIds.has(pluginId))) {
    return false;
  }
  const installOwners = new Set(persisted.plugins.map(resolveInstalledPluginIndexInstallOwner));
  return Object.entries(persisted.installRecords).every(([installOwner, record]) => {
    if (installOwners.has(installOwner)) {
      return true;
    }
    const installedPath = record.installPath?.trim() || record.sourcePath?.trim();
    // Missing package bytes are orphaned owner records, not rediscoverable plugins.
    return !installedPath || !existsSync(resolveUserPath(installedPath, env));
  });
}

function canRefreshPersistedPolicyState(
  persisted: InstalledPluginIndex | null,
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): persisted is InstalledPluginIndex {
  if (!persisted || params.reason !== "policy-changed") {
    return false;
  }
  if (
    (params.diagnostics?.length ?? 0) > 0 ||
    persisted.diagnostics.some((diagnostic) => diagnostic.code === "workspace-scope-omitted") ||
    hasInstalledPluginIndexWorkspaceScopeMismatch(persisted, params.workspaceDir)
  ) {
    return false;
  }
  const env = params.env ?? process.env;
  if (
    persisted.version !== INSTALLED_PLUGIN_INDEX_VERSION ||
    persisted.hostContractVersion !== resolveCompatibilityHostVersion(env) ||
    persisted.compatRegistryVersion !== resolveCompatRegistryVersion() ||
    persisted.migrationVersion !== INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION ||
    hasMissingConfigPathActivationMetadata(persisted) ||
    hasMissingInstalledPluginOwnerMetadata(persisted, env)
  ) {
    return false;
  }
  if (
    params.installRecords &&
    hashStableJson(params.installRecords) !== hashStableJson(persisted.installRecords ?? {})
  ) {
    return false;
  }
  return hasCompletePolicyRefreshProjection(persisted, params.policyPluginIds, env);
}

function refreshPersistedPolicyState(
  persisted: InstalledPluginIndex,
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  const activationConfig = withBundledPluginEnablementCompat({
    config: params.config,
    env: params.env,
    pluginIds: persisted.plugins
      .filter((plugin) =>
        isBundledProviderCompatPlugin({
          origin: plugin.origin,
          providers: plugin.contributions?.providers,
          contracts: plugin.contributions?.contracts,
        }),
      )
      .map((plugin) => plugin.pluginId),
    activation: "defaults",
  });
  const normalizedConfig = normalizePluginsConfig(activationConfig?.plugins);
  return {
    ...persisted,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config, params.env),
    generatedAtMs: (params.now?.() ?? new Date()).getTime(),
    refreshReason: params.reason,
    plugins: persisted.plugins.map((plugin) => ({
      ...plugin,
      enabled: resolveEffectiveEnableState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: activationConfig,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
      }).enabled,
    })),
  };
}

export async function refreshPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<InstalledPluginIndex> {
  return refreshPersistedInstalledPluginIndexSync(params);
}

function resolveRefreshedPersistedInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): InstalledPluginIndex {
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? readPersistedInstalledPluginIndexSync(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    return refreshPersistedPolicyState(persisted, params);
  }
  return refreshInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
  });
}

export function refreshPersistedInstalledPluginIndexSync(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): InstalledPluginIndex {
  const index = resolveRefreshedPersistedInstalledPluginIndex(params);
  writePersistedInstalledPluginIndexSync(index, params);
  return index;
}

export function refreshPersistedInstalledPluginIndexWithLeaseSync(
  params: RefreshInstalledPluginIndexParams &
    InstalledPluginIndexStoreOptions & {
      lease: InstalledPluginIndexWriteLease;
    },
): InstalledPluginIndexWriteReceipt {
  const { lease, ...storeParams } = params;
  const index = resolveRefreshedPersistedInstalledPluginIndex(storeParams);
  const receipt = writePersistedInstalledPluginIndexToSqlite(index, storeParams, lease);
  clearPersistedInstalledPluginIndexCaches();
  return receipt;
}
