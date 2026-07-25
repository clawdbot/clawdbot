/** Persists, inspects, and refreshes the installed plugin index in the state database. */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { hashJson } from "./installed-plugin-index-hash.js";
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
  type InstalledPluginInstallRecordInfo,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";
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

const StringArraySchema = z.array(z.string());
const INSTALLED_PLUGIN_INDEX_SQLITE_KEY = "installed-plugin-index";

const InstalledPluginIndexStartupSchema = z.object({
  sidecar: z.boolean(),
  memory: z.boolean(),
  deferConfiguredChannelFullLoadUntilAfterListen: z.boolean(),
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
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  installRecord: z.record(z.string(), z.unknown()).optional(),
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

const InstalledPluginInstallRecordSchema = z.record(z.string(), z.unknown());

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
  installRecords: z.record(z.string(), InstalledPluginInstallRecordSchema).optional(),
  plugins: z.array(InstalledPluginIndexRecordSchema),
  diagnostics: z.array(PluginDiagnosticSchema),
});

function copySafeInstallRecords(
  records: Readonly<Record<string, InstalledPluginInstallRecordInfo>> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> | undefined {
  if (!records) {
    return undefined;
  }
  const safeRecords: Record<string, InstalledPluginInstallRecordInfo> = {};
  for (const [pluginId, record] of Object.entries(records)) {
    if (isBlockedObjectKey(pluginId)) {
      continue;
    }
    safeRecords[pluginId] = record;
  }
  return safeRecords;
}

export function parseInstalledPluginIndex(value: unknown): InstalledPluginIndex | null {
  const parsed = safeParseWithSchema(InstalledPluginIndexSchema, value) as
    | (Omit<InstalledPluginIndex, "installRecords"> & {
        installRecords?: InstalledPluginIndex["installRecords"];
      })
    | null;
  if (!parsed) {
    return null;
  }
  const installRecords =
    copySafeInstallRecords(parsed.installRecords) ??
    copySafeInstallRecords(
      extractPluginInstallRecordsFromInstalledPluginIndex(parsed as InstalledPluginIndex),
    ) ??
    {};
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
    plugins: parsed.plugins,
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
};

function isExplicitLegacyJsonStorePath(options: InstalledPluginIndexStoreOptions): boolean {
  return Boolean(options.filePath && options.filePath.endsWith(".json"));
}

function readLegacyRecordContainer(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const legacy = value as { installRecords?: unknown; records?: unknown };
  return legacy.installRecords ?? legacy.records;
}

function readPersistedInstalledPluginIndexFromLegacyJson(
  options: InstalledPluginIndexStoreOptions,
): InstalledPluginIndex | null {
  if (!options.filePath || !existsSync(options.filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(options.filePath, "utf8")) as unknown;
    const current = parseInstalledPluginIndex(parsed);
    if (current) {
      return current;
    }
    const installRecords = readLegacyRecordContainer(parsed);
    if (!installRecords) {
      return null;
    }
    return parseInstalledPluginIndex({
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      hostContractVersion: "legacy-file",
      compatRegistryVersion: "legacy-file",
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: "legacy-file",
      generatedAtMs: 0,
      installRecords,
      plugins: [],
      diagnostics: [],
    });
  } catch {
    return null;
  }
}

function assertWritableInstalledPluginIndexStoreOptions(
  options: InstalledPluginIndexStoreOptions,
): void {
  if (isExplicitLegacyJsonStorePath(options)) {
    throw new Error(
      "Explicit JSON installed plugin index paths are retired. Use the shared SQLite state DB or run openclaw doctor --fix to migrate legacy plugins/installs.json.",
    );
  }
}

function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
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
    installRecords: parseJsonColumn(row.install_records_json),
    plugins: parseJsonColumn(row.plugins_json),
    diagnostics: parseJsonColumn(row.diagnostics_json),
  });
}

function readPersistedInstalledPluginIndexFromSqlite(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  if (isExplicitLegacyJsonStorePath(options)) {
    return readPersistedInstalledPluginIndexFromLegacyJson(options);
  }
  if (!existsSync(resolveInstalledPluginIndexStorePath(options))) {
    return null;
  }
  try {
    return withOpenClawStateDatabaseReadOnly(({ db }) => {
      const row = db
        .prepare(
          `
            SELECT version, warning, host_contract_version, compat_registry_version,
                   migration_version, policy_hash, generated_at_ms, refresh_reason,
                   install_records_json, plugins_json, diagnostics_json
              FROM installed_plugin_index
             WHERE index_key = ?
          `,
        )
        .get(INSTALLED_PLUGIN_INDEX_SQLITE_KEY) as InstalledPluginIndexSqliteRow | undefined;
      return parseInstalledPluginIndexSqliteRow(row);
    }, resolveInstalledPluginIndexStateDatabaseOptions(options));
  } catch {
    return null;
  }
}

function writePersistedInstalledPluginIndexToSqlite(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): void {
  assertWritableInstalledPluginIndexStoreOptions(options);
  const persisted = {
    ...index,
    warning: INSTALLED_PLUGIN_INDEX_WARNING,
    installRecords: copySafeInstallRecords(index.installRecords) ?? {},
  };
  const now = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
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
    ).run({
      index_key: INSTALLED_PLUGIN_INDEX_SQLITE_KEY,
      version: persisted.version,
      host_contract_version: persisted.hostContractVersion,
      compat_registry_version: persisted.compatRegistryVersion,
      migration_version: persisted.migrationVersion,
      policy_hash: persisted.policyHash,
      generated_at_ms: persisted.generatedAtMs,
      refresh_reason: persisted.refreshReason ?? null,
      install_records_json: JSON.stringify(persisted.installRecords),
      plugins_json: JSON.stringify(persisted.plugins),
      diagnostics_json: JSON.stringify(persisted.diagnostics),
      warning: persisted.warning,
      updated_at_ms: now,
    });
  }, resolveInstalledPluginIndexStateDatabaseOptions(options));
}

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  return readPersistedInstalledPluginIndexFromSqlite(options);
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
  const filePath = resolveInstalledPluginIndexStorePath(options);
  writePersistedInstalledPluginIndexToSqlite(index, options);
  clearPluginMetadataLifecycleCaches();
  clearLoadInstalledPluginIndexInstallRecordsCache();
  return filePath;
}

export function writePersistedInstalledPluginIndexSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): string {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  writePersistedInstalledPluginIndexToSqlite(index, options);
  clearPluginMetadataLifecycleCaches();
  clearLoadInstalledPluginIndexInstallRecordsCache();
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
    hasMissingConfigPathActivationMetadata(persisted)
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
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? await readPersistedInstalledPluginIndex(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    const index = refreshPersistedPolicyState(persisted, params);
    await writePersistedInstalledPluginIndex(index, params);
    return index;
  }
  const index = refreshInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
  });
  await writePersistedInstalledPluginIndex(index, params);
  return index;
}

export function refreshPersistedInstalledPluginIndexSync(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): InstalledPluginIndex {
  const persisted =
    params.reason === "policy-changed" || !params.installRecords
      ? readPersistedInstalledPluginIndexSync(params)
      : null;
  if (canRefreshPersistedPolicyState(persisted, params)) {
    const index = refreshPersistedPolicyState(persisted, params);
    writePersistedInstalledPluginIndexSync(index, params);
    return index;
  }
  const index = refreshInstalledPluginIndex({
    ...params,
    installRecords:
      params.installRecords ?? extractPluginInstallRecordsFromInstalledPluginIndex(persisted),
  });
  writePersistedInstalledPluginIndexSync(index, params);
  return index;
}
