/** Reads and parses the installed plugin index in the state database. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import {
  parsePluginInstallRecordMap,
  PluginInstallRecordSchema,
} from "../config/plugin-install-record-map.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";

export {
  resolveInstalledPluginIndexStorePath,
  resolveLegacyInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

const StringArraySchema = z.array(z.string());
// Shared with installed-plugin-index-store-write.ts.
export const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

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

// Shared with installed-plugin-index-store-write.ts.
export type PersistedInstalledPluginIndexValue = {
  revision: number;
  index: unknown;
};

// Shared with installed-plugin-index-store-write.ts.
export function parseInstalledPluginIndexSqliteRow(
  value: PersistedInstalledPluginIndexValue | undefined,
): InstalledPluginIndex | null {
  return value ? parseInstalledPluginIndex(value.index) : null;
}

// Shared with installed-plugin-index-store-write.ts.
export function readInstalledPluginIndexRow(
  database: DatabaseSync,
): PersistedInstalledPluginIndexValue | undefined {
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    // SAFETY: config_machine_state.value_json is TEXT NOT NULL under STRICT.
    .get(INSTALLED_PLUGIN_INDEX_STATE_KEY) as { value_json: string } | undefined;
  return parsePersistedInstalledPluginIndexRow(row);
}

function parsePersistedInstalledPluginIndexRow(
  row: { value_json: string } | undefined,
): PersistedInstalledPluginIndexValue | undefined {
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

export async function readPersistedInstalledPluginIndex(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<InstalledPluginIndex | null> {
  return readPersistedInstalledPluginIndexSync(options);
}

export function readPersistedInstalledPluginIndexSync(
  options: InstalledPluginIndexStoreOptions = {},
): InstalledPluginIndex | null {
  return parseInstalledPluginIndexSqliteRow(
    parsePersistedInstalledPluginIndexRow(readPersistedInstalledPluginIndexRowSync(options)),
  );
}
