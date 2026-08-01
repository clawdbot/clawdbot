// Doctor migration from legacy shipped plugin install config into persisted install registry.
import fs from "node:fs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  extractShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "../../../config/plugin-install-config-migration.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "../../../plugins/installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
} from "../../../plugins/installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../../../plugins/manifest-registry-installed.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";

const DOCTOR_PLUGIN_ID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  openai: ["openai-codex"],
};

type PluginRegistryInstallMigrationPreflightAction = "skip-existing" | "migrate";

type PluginRegistryInstallMigrationPreflight = {
  /** Migration action selected before reading or writing registry state. */
  action: PluginRegistryInstallMigrationPreflightAction;
  /** Persisted plugin index path that migration will inspect or write. */
  filePath: string;
};

type PluginRegistryInstallMigrationResult =
  | {
      status: "skip-existing" | "dry-run";
      migrated: false;
      preflight: PluginRegistryInstallMigrationPreflight;
    }
  | {
      status: "migrated";
      migrated: true;
      preflight: PluginRegistryInstallMigrationPreflight;
      inspection: InstalledPluginIndexStoreInspection;
      current: InstalledPluginIndex;
    };

export type PluginRegistryInstallMigrationParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    dryRun?: boolean;
    existsSync?: (path: string) => boolean;
    readConfig?: () => Promise<OpenClawConfig> | OpenClawConfig;
  };

/** Decide whether plugin install registry migration should run for this environment. */
export function preflightPluginRegistryInstallMigration(
  params: PluginRegistryInstallMigrationParams = {},
): PluginRegistryInstallMigrationPreflight {
  const filePath = resolveInstalledPluginIndexStorePath(params);
  const pathExists = params.existsSync ?? fs.existsSync;
  if (pathExists(filePath)) {
    const currentRegistry = readPersistedInstalledPluginIndexSync(params);
    if (currentRegistry) {
      return {
        action: "skip-existing",
        filePath,
      };
    }
  }
  return {
    action: "migrate",
    filePath,
  };
}

async function readMigrationConfig(
  params: PluginRegistryInstallMigrationParams,
): Promise<OpenClawConfig> {
  if (params.config) {
    return params.config;
  }
  if (params.readConfig) {
    return await params.readConfig();
  }
  const configModule = await import("../../../config/config.js");
  return await configModule.readBestEffortConfig();
}

function normalizeRegistryReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function createMigrationPluginIdNormalizer(
  index: InstalledPluginIndex,
  manifests: readonly PluginManifestRecord[],
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    const pluginId = normalizeRegistryReference(plugin.pluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(pluginId, plugin.pluginId);
  }
  for (const plugin of manifests) {
    const pluginId = normalizeRegistryReference(plugin.id);
    if (!pluginId) {
      continue;
    }
    aliases.set(pluginId, plugin.id);
    for (const alias of [
      ...plugin.providers,
      ...plugin.channels,
      ...(plugin.setup?.providers?.map((provider) => provider.id) ?? []),
      ...plugin.cliBackends,
      ...(plugin.setup?.cliBackends ?? []),
      ...Object.keys(plugin.modelCatalog?.providers ?? {}),
      ...(plugin.legacyPluginIds ?? []),
      ...(DOCTOR_PLUGIN_ID_ALIASES[plugin.id] ?? []),
    ]) {
      const normalizedAlias = normalizeRegistryReference(alias);
      if (normalizedAlias && !aliases.has(normalizedAlias)) {
        aliases.set(normalizedAlias, plugin.id);
      }
    }
  }
  return (pluginId: string) => {
    const normalized = normalizeRegistryReference(pluginId);
    return normalized ? (aliases.get(normalized) ?? pluginId.trim()) : pluginId.trim();
  };
}

function addPluginReference(
  references: Set<string>,
  normalizePluginId: (pluginId: string) => string,
  value: unknown,
): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = normalizePluginId(value);
  if (normalized) {
    references.add(normalized);
  }
}

function listConfiguredChannelIds(config: OpenClawConfig): Set<string> {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return new Set();
  }
  return new Set(
    Object.keys(channels)
      .map((channelId) => normalizeRegistryReference(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
}

function listConfiguredModelProviderIds(config: OpenClawConfig): Set<string> {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return new Set();
  }
  return new Set(
    Object.keys(providers)
      .map((providerId) => normalizeProviderId(providerId))
      .filter(Boolean),
  );
}

function listMigrationRelevantPluginRecords(params: {
  index: InstalledPluginIndex;
  config: OpenClawConfig;
  installRecords: Record<string, unknown>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): readonly InstalledPluginIndexRecord[] {
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index: params.index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  const manifestByPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  const normalizePluginId = createMigrationPluginIdNormalizer(
    params.index,
    manifestRegistry.plugins,
  );
  const referencedPluginIds = new Set<string>();
  const installedPluginIds = new Set<string>();

  for (const pluginId of Object.keys(params.installRecords)) {
    addPluginReference(installedPluginIds, normalizePluginId, pluginId);
  }

  const plugins = params.config.plugins;
  for (const pluginId of plugins?.allow ?? []) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of plugins?.deny ?? []) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of Object.keys(plugins?.entries ?? {})) {
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }
  for (const pluginId of Object.values(plugins?.slots ?? {})) {
    if (normalizeRegistryReference(pluginId) === "none") {
      continue;
    }
    addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
  }

  const configuredChannelIds = listConfiguredChannelIds(params.config);
  const configuredModelProviderIds = listConfiguredModelProviderIds(params.config);

  return params.index.plugins.filter((plugin) => {
    if (plugin.origin !== "bundled") {
      return true;
    }
    const manifest = manifestByPluginId.get(plugin.pluginId);
    if (plugin.enabledByDefault && (manifest?.providers.length ?? 0) > 0) {
      return true;
    }
    if (plugin.startup.memory) {
      return true;
    }
    if ((manifest?.commandAliases ?? []).some((alias) => alias.cliCommand)) {
      return true;
    }
    if ((manifest?.contracts?.migrationProviders?.length ?? 0) > 0) {
      return true;
    }
    if (installedPluginIds.has(plugin.pluginId) || referencedPluginIds.has(plugin.pluginId)) {
      return true;
    }
    if (
      (manifest?.channels ?? []).some((channelId) =>
        configuredChannelIds.has(normalizeRegistryReference(channelId) ?? ""),
      )
    ) {
      return true;
    }
    return (manifest?.providers ?? []).some((providerId) =>
      configuredModelProviderIds.has(normalizeProviderId(providerId)),
    );
  });
}

/** Persist a migrated plugin install registry from legacy config/install records when needed. */
export async function migratePluginRegistryForInstall(
  params: PluginRegistryInstallMigrationParams = {},
): Promise<PluginRegistryInstallMigrationResult> {
  const preflight = preflightPluginRegistryInstallMigration(params);
  if (preflight.action === "skip-existing") {
    return { status: "skip-existing", migrated: false, preflight };
  }
  if (params.dryRun) {
    return { status: "dry-run", migrated: false, preflight };
  }

  const rawConfig = await readMigrationConfig(params);
  const config = stripShippedPluginInstallConfigRecords(rawConfig) as OpenClawConfig;
  const durableInstallRecords =
    params.installRecords ?? (await loadInstalledPluginIndexInstallRecords(params));
  const installRecords = {
    ...extractShippedPluginInstallConfigRecords(rawConfig),
    ...durableInstallRecords,
  };
  const migrationParams = {
    ...params,
    config,
    installRecords,
  };
  const inspection = await inspectPersistedInstalledPluginIndex(migrationParams);
  const candidateIndex = loadInstalledPluginIndex({
    ...migrationParams,
  });
  const current: InstalledPluginIndex = {
    ...candidateIndex,
    refreshReason: "migration",
    plugins: listMigrationRelevantPluginRecords({
      index: candidateIndex,
      config,
      installRecords,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }),
  };
  await writePersistedInstalledPluginIndex(current, params);
  return {
    status: "migrated",
    migrated: true,
    preflight,
    inspection,
    current,
  };
}
