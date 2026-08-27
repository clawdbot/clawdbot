/** Persists, inspects, and refreshes the installed plugin index in the state database. */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
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
import { resolveUserPath } from "../infra/home-dir.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
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
export {
  resolveInstalledPluginIndexStorePath,
  resolveLegacyInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

export type InstalledPluginIndexWriteLease = {
  assertOwnedInTransaction(database: DatabaseSync): void;
};

export type InstalledPluginIndexWriteReceipt = {
  previous: InstalledPluginIndex | null;
  revision: number;
};

const StringArraySchema = z.array(z.string());
const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

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
  code: z.string().optional(),
});

const InstalledPluginIndexSchema = z.object({
  version: z.literal(INSTALLED_PLUGIN_INDEX_VERSION),
  warning: z.string().optional(),
  hostContractVersion: z.string(),
  compatRegistryVersion: z.string(),
  migrationVersion: z.literal(INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION),
  policyHash: z.string(),
  generatedAtMs: z.number(),
  workspaceDir: z.string().optional(),
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
    ...(parsed.workspaceDir !== undefined ? { workspaceDir: parsed.workspaceDir } : {}),
    ...(parsed.refreshReason ? { refreshReason: parsed.refreshReason } : {}),
    installRecords,
    plugins: parsed.plugins.map(({ installOwner, installOwnerAmbiguous, ...plugin }) =>
      recordInstalledPluginIndexInstallOwner(plugin, installOwner, installOwnerAmbiguous === true),
    ),
    diagnostics: parsed.diagnostics,
  };
}

type PersistedInstalledPluginIndexValue = {
  revision: number;
  index: unknown;
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
  value: PersistedInstalledPluginIndexValue | undefined,
): InstalledPluginIndex | null {
  return value ? parseInstalledPluginIndex(value.index) : null;
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
): PersistedInstalledPluginIndexValue | undefined {
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    // SAFETY: config_machine_state.value_json is TEXT NOT NULL under STRICT.
    .get(INSTALLED_PLUGIN_INDEX_STATE_KEY) as { value_json: string } | undefined;
  if (!row) {
    return undefined;
  }
  const value = safeParseJson(row.value_json);
  if (
    !value ||
    typeof value !== "object" ||
    // SAFETY: shape-checked field probe; the full value is validated below.
    typeof (value as PersistedInstalledPluginIndexValue).revision !== "number"
  ) {
    return undefined;
  }
  // SAFETY: revision checked above; index stays unknown until parseInstalledPluginIndex.
  return value as PersistedInstalledPluginIndexValue;
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

function readPersistedInstalledPluginIndexFromSqlite(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  if (options.filePath?.endsWith(".json")) {
    return null;
  }
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => parseInstalledPluginIndexSqliteRow(readInstalledPluginIndexRow(db)),
        resolveInstalledPluginIndexStateDatabaseOptions(options),
      ) ?? null
    );
  } catch (error) {
    if (isSqliteSchemaVersionError(error)) {
      throw error;
    }
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
