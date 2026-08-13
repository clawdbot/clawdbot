/** Persists, inspects, and refreshes the installed plugin index in the state database. */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { z } from "zod";
import {
  createPluginInstallRecordMap,
  inspectPluginInstallRecordMap,
  parsePluginInstallRecord,
  parsePluginInstallRecordMap,
  PluginInstallRecordSchema,
  serializePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  recordInstalledPluginIndexInstallOwner,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { resolveCompatRegistryVersion } from "./installed-plugin-index-policy.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  extractPluginInstallRecordsFromInstalledPluginIndex,
  hasMissingConfigPathActivationMetadata,
  INSTALLED_PLUGIN_INDEX_WARNING,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  refreshInstalledPluginIndex,
  type InstalledPluginIndex,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
import { hasMissingInstalledPluginOwnerMetadata } from "./installed-plugin-package-ownership.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
export {
  resolveInstalledPluginIndexStorePath,
  resolveLegacyInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

/** Freshness state for the persisted installed plugin index. */
type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";

export type InstalledPluginIndexStoreInspection = {
  state: InstalledPluginIndexStoreState;
  refreshReasons: readonly InstalledPluginIndexRefreshReason[];
  persisted: InstalledPluginIndex | null;
  current: InstalledPluginIndex;
};

export type InstalledPluginIndexWriteLease = {
  assertOwnedInTransaction(database: DatabaseSync): void;
};

export type InstalledPluginIndexWriteReceipt = {
  previous: InstalledPluginIndex | null;
  revision: number;
};

const StringArraySchema = z.array(z.string());
const INSTALLED_PLUGIN_INDEX_SQLITE_KEY = "installed-plugin-index";

const InstalledPluginIndexStartupSchema = z.object({
  sidecar: z.boolean(),
  memory: z.boolean(),
  agentHarnesses: StringArraySchema,
  configPaths: StringArraySchema.optional(),
});

const InstalledPluginIndexContributionSchema = z.object({
  channels: StringArraySchema,
  channelConfigs: StringArraySchema,
  providers: StringArraySchema,
  modelCatalogProviders: StringArraySchema,
  modelSupportPrefixes: StringArraySchema,
  modelSupportPatterns: StringArraySchema,
  autoEnableProviderIds: StringArraySchema,
  commandAliases: StringArraySchema,
  contracts: z.record(z.string(), StringArraySchema),
});

const InstalledPluginFileSignatureSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number().optional(),
});

const InstalledPluginIndexRecordSchema = z.object({
  pluginId: z.string(),
  installOwner: z.string().optional(),
  installOwnerAmbiguous: z.literal(true).optional(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  installRecord: PluginInstallRecordSchema.optional(),
  installRecordHash: z.string().optional(),
  packageInstall: z.unknown().optional(),
  packageChannel: z.unknown().optional(),
  packageBuild: z
    .object({
      bundledDist: z.boolean().optional(),
    })
    .optional(),
  manifestPath: z.string(),
  manifestHash: z.string(),
  doctorContractHash: z.string().optional(),
  doctorContractFile: InstalledPluginFileSignatureSchema.optional(),
  manifestFile: InstalledPluginFileSignatureSchema.optional(),
  format: z.string().optional(),
  bundleFormat: z.string().optional(),
  source: z.string().optional(),
  setupSource: z.string().optional(),
  packageJson: z
    .object({
      path: z.string(),
      hash: z.string(),
      fileSignature: InstalledPluginFileSignatureSchema.optional(),
    })
    .optional(),
  rootDir: z.string(),
  origin: z.string(),
  enabled: z.boolean(),
  enabledByDefault: z.boolean().optional(),
  enabledByDefaultOnPlatforms: StringArraySchema.optional(),
  syntheticAuthRefs: StringArraySchema.optional(),
  startup: InstalledPluginIndexStartupSchema,
  contributions: InstalledPluginIndexContributionSchema.optional(),
  compat: z.array(z.string()),
});

const PluginDiagnosticSchema = z.object({
  level: z.union([z.literal("warn"), z.literal("error")]),
  message: z.string(),
  pluginId: z.string().optional(),
  source: z.string().optional(),
});

const InstalledPluginIndexSchema = z.object({
  version: z.literal(INSTALLED_PLUGIN_INDEX_VERSION),
  warning: z.string().optional(),
  hostContractVersion: z.string(),
  compatRegistryVersion: z.string(),
  migrationVersion: z.literal(INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION),
  policyHash: z.string(),
  generatedAtMs: z.number(),
  refreshReason: z.string().optional(),
  installRecords: z.unknown().optional(),
  plugins: z.array(InstalledPluginIndexRecordSchema),
  diagnostics: z.array(PluginDiagnosticSchema),
});

export function parseInstalledPluginIndex(value: unknown): InstalledPluginIndex | null {
  const parsed = safeParseWithSchema(InstalledPluginIndexSchema, value) as
    | (Omit<InstalledPluginIndex, "installRecords" | "plugins"> & {
        installRecords?: unknown;
        plugins: Array<
          InstalledPluginIndex["plugins"][number] & {
            installOwner?: string;
            installOwnerAmbiguous?: true;
          }
        >;
      })
    | null;
  if (!parsed) {
    return null;
  }
  const installRecords = Object.hasOwn(parsed, "installRecords")
    ? parsePluginInstallRecordMap(parsed.installRecords)
    : extractPluginInstallRecordsFromInstalledPluginIndex(parsed as InstalledPluginIndex);
  if (!installRecords) {
    return null;
  }
  return {
    version: parsed.version,
    ...(parsed.warning ? { warning: parsed.warning } : {}),
    hostContractVersion: parsed.hostContractVersion,
    compatRegistryVersion: parsed.compatRegistryVersion,
    migrationVersion: parsed.migrationVersion,
    policyHash: parsed.policyHash,
    generatedAtMs: parsed.generatedAtMs,
    ...(parsed.refreshReason ? { refreshReason: parsed.refreshReason } : {}),
    installRecords,
    plugins: parsed.plugins.map(({ installOwner, installOwnerAmbiguous, ...plugin }) =>
      recordInstalledPluginIndexInstallOwner(plugin, installOwner, installOwnerAmbiguous === true),
    ),
    diagnostics: parsed.diagnostics,
  };
}

type InstalledPluginIndexSqliteRow = {
  version: number | bigint;
  warning: string | null;
  host_contract_version: string;
  compat_registry_version: string;
  migration_version: number | bigint;
  policy_hash: string;
  generated_at_ms: number | bigint;
  refresh_reason: string | null;
  install_records_json: string;
  plugins_json: string;
  diagnostics_json: string;
  updated_at_ms: number | bigint;
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

function parseInstalledPluginIndexSqliteRow(
  row: InstalledPluginIndexSqliteRow | undefined,
): InstalledPluginIndex | null {
  if (!row) {
    return null;
  }
  return parseInstalledPluginIndex({
    version: Number(row.version),
    ...(row.warning ? { warning: row.warning } : {}),
    hostContractVersion: row.host_contract_version,
    compatRegistryVersion: row.compat_registry_version,
    migrationVersion: Number(row.migration_version),
    policyHash: row.policy_hash,
    generatedAtMs: Number(row.generated_at_ms),
    ...(row.refresh_reason ? { refreshReason: row.refresh_reason } : {}),
    installRecords: safeParseJson(row.install_records_json),
    plugins: safeParseJson(row.plugins_json),
    diagnostics: safeParseJson(row.diagnostics_json),
  });
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

function readInstalledPluginIndexRow(
  database: DatabaseSync,
): InstalledPluginIndexSqliteRow | undefined {
  return database
    .prepare(
      `
        SELECT version, warning, host_contract_version, compat_registry_version,
               migration_version, policy_hash, generated_at_ms, refresh_reason,
               install_records_json, plugins_json, diagnostics_json, updated_at_ms
          FROM installed_plugin_index
         WHERE index_key = ?
      `,
    )
    .get(INSTALLED_PLUGIN_INDEX_SQLITE_KEY) as InstalledPluginIndexSqliteRow | undefined;
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
  database
    .prepare(
      `
        INSERT INTO installed_plugin_index (
          index_key, version, host_contract_version, compat_registry_version,
          migration_version, policy_hash, generated_at_ms, refresh_reason,
          install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
        ) VALUES (
          @index_key, @version, @host_contract_version, @compat_registry_version,
          @migration_version, @policy_hash, @generated_at_ms, @refresh_reason,
          @install_records_json, @plugins_json, @diagnostics_json, @warning, @updated_at_ms
        )
        ON CONFLICT(index_key) DO UPDATE SET
          version = excluded.version,
          host_contract_version = excluded.host_contract_version,
          compat_registry_version = excluded.compat_registry_version,
          migration_version = excluded.migration_version,
          policy_hash = excluded.policy_hash,
          generated_at_ms = excluded.generated_at_ms,
          refresh_reason = excluded.refresh_reason,
          install_records_json = excluded.install_records_json,
          plugins_json = excluded.plugins_json,
          diagnostics_json = excluded.diagnostics_json,
          warning = excluded.warning,
          updated_at_ms = excluded.updated_at_ms
      `,
    )
    .run({
      index_key: INSTALLED_PLUGIN_INDEX_SQLITE_KEY,
      version: index.version,
      host_contract_version: index.hostContractVersion,
      compat_registry_version: index.compatRegistryVersion,
      migration_version: index.migrationVersion,
      policy_hash: index.policyHash,
      generated_at_ms: index.generatedAtMs,
      refresh_reason: index.refreshReason ?? null,
      install_records_json: serializePluginInstallRecordMap(index.installRecords),
      plugins_json: JSON.stringify(
        index.plugins.map((plugin) => {
          const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
          return {
            ...plugin,
            ...(installOwner ? { installOwner } : {}),
            ...(isInstalledPluginIndexInstallOwnerAmbiguous(plugin)
              ? { installOwnerAmbiguous: true }
              : {}),
          };
        }),
      ),
      diagnostics_json: JSON.stringify(index.diagnostics),
      warning: index.warning ?? INSTALLED_PLUGIN_INDEX_WARNING,
      updated_at_ms: revision,
    });
}

function readPersistedInstalledPluginIndexFromSqlite(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  if (options.filePath?.endsWith(".json")) {
    return null;
  }
  if (!existsSync(resolveInstalledPluginIndexStorePath(options))) {
    return null;
  }
  try {
    return withOpenClawStateDatabaseReadOnly(
      ({ db }) => parseInstalledPluginIndexSqliteRow(readInstalledPluginIndexRow(db)),
      resolveInstalledPluginIndexStateDatabaseOptions(options),
    );
  } catch {
    return null;
  }
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
      const previousInstallRecords = safeParseJson(previousRow.install_records_json);
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
      previousRow ? Number(previousRow.updated_at_ms) : null,
    );
    writePersistedInstalledPluginIndexRow(db, persisted, revision);
    return {
      previous: parseInstalledPluginIndexSqliteRow(previousRow),
      revision,
    };
  }, resolveInstalledPluginIndexStateDatabaseOptions(options));
}

function clearPersistedInstalledPluginIndexCaches(): void {
  clearPluginMetadataLifecycleCaches();
  clearLoadInstalledPluginIndexInstallRecordsCache();
}

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  return readPersistedInstalledPluginIndexSync(options);
}

export function readPersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  return readPersistedInstalledPluginIndexFromSqlite(options);
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
    const currentRevision = currentRow ? Number(currentRow.updated_at_ms) : null;
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
      db.prepare(
        `
          DELETE FROM installed_plugin_index
           WHERE index_key = ?
        `,
      ).run(INSTALLED_PLUGIN_INDEX_SQLITE_KEY);
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

function hasPolicyRefreshTargets(
  persisted: InstalledPluginIndex,
  policyPluginIds: readonly string[] | undefined,
): boolean {
  if (!policyPluginIds || policyPluginIds.length === 0) {
    return true;
  }
  const pluginIds = new Set(persisted.plugins.map((plugin) => plugin.pluginId));
  return policyPluginIds.every((pluginId) => pluginIds.has(pluginId));
}

function canRefreshPersistedPolicyState(
  persisted: InstalledPluginIndex | null,
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): persisted is InstalledPluginIndex {
  if (!persisted || params.reason !== "policy-changed") {
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
    hashJson(params.installRecords) !== hashJson(persisted.installRecords ?? {})
  ) {
    return false;
  }
  return hasPolicyRefreshTargets(persisted, params.policyPluginIds);
}

function refreshPersistedPolicyState(
  persisted: InstalledPluginIndex,
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return {
    ...persisted,
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    generatedAtMs: (params.now?.() ?? new Date()).getTime(),
    refreshReason: params.reason,
    plugins: persisted.plugins.map((plugin) => ({
      ...plugin,
      enabled: resolveEffectiveEnableState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
      }).enabled,
    })),
  };
}

export async function inspectPersistedInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndexStoreInspection> {
  const persisted = await readPersistedInstalledPluginIndex(params);
  const current = loadInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
  });
  if (!persisted) {
    return {
      state: "missing",
      refreshReasons: ["missing"],
      persisted: null,
      current,
    };
  }

  const refreshReasons = diffInstalledPluginIndexInvalidationReasons(persisted, current);
  return {
    state: refreshReasons.length > 0 ? "stale" : "fresh",
    refreshReasons,
    persisted,
    current,
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
