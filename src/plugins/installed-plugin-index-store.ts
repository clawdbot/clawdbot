import { z } from "zod";
import { saveJsonFile } from "../infra/json-file.js";
import { readJsonFile, readJsonFileSync, writeJsonAtomic } from "../infra/json-files.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveCompatRegistryVersion } from "./installed-plugin-index-policy.js";
import {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  extractPluginInstallRecordsFromInstalledPluginIndex,
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
export {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

export type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";

export type InstalledPluginIndexStoreInspection = {
  state: InstalledPluginIndexStoreState;
  refreshReasons: readonly InstalledPluginIndexRefreshReason[];
  persisted: InstalledPluginIndex | null;
  current: InstalledPluginIndex;
};

const StringArraySchema = z.array(z.string());

const InstalledPluginIndexStartupSchema = z.object({
  sidecar: z.boolean(),
  memory: z.boolean(),
  deferConfiguredChannelFullLoadUntilAfterListen: z.boolean(),
  agentHarnesses: StringArraySchema,
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
  syntheticAuthRefs: StringArraySchema.optional(),
  startup: InstalledPluginIndexStartupSchema,
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

function parseInstalledPluginIndex(value: unknown): InstalledPluginIndex | null {
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

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  const parsed = await readJsonFile<unknown>(resolveInstalledPluginIndexStorePath(options));
  return parseInstalledPluginIndex(parsed);
}

export function readPersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  const parsed = readJsonFileSync(resolveInstalledPluginIndexStorePath(options));
  return parseInstalledPluginIndex(parsed);
}

export async function writePersistedInstalledPluginIndex(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): Promise<string> {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  await writeJsonAtomic(
    filePath,
    { ...index, warning: INSTALLED_PLUGIN_INDEX_WARNING },
    {
      trailingNewline: true,
      ensureDirMode: 0o700,
      mode: 0o600,
    },
  );
  clearCurrentPluginMetadataSnapshotState();
  return filePath;
}

export function writePersistedInstalledPluginIndexSync(
  index: InstalledPluginIndex,
  options: InstalledPluginIndexStoreOptions = {},
): string {
  const filePath = resolveInstalledPluginIndexStorePath(options);
  saveJsonFile(filePath, { ...index, warning: INSTALLED_PLUGIN_INDEX_WARNING });
  clearCurrentPluginMetadataSnapshotState();
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
    persisted.migrationVersion !== INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION
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
        enabledByDefault: plugin.enabledByDefault,
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
