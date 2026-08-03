import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Builds deterministic metadata scopes for startup and config validation.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { addRequiredAgentHarnessPluginIds } from "./gateway-startup-plugin-activation.js";
import {
  addConfiguredActivationPathPluginIds,
  addConfiguredSlotPluginIds,
  addPluginConfigEntryIds,
  collectConfigValidationChannelIds,
  collectConfiguredProviderIds,
  collectConfiguredStartupChannelIds,
  collectValidationConfiguredProviderIds,
  collectValidationConfiguredShorthandModelIds,
  normalizePluginsConfigForInstalledIndex,
  readStartupBundledDiscoveryMode,
  resolveAuthorizedGatewayStartupDreamingPluginIds,
  resolveMemorySlotStartupPluginId,
} from "./gateway-startup-plugin-config.js";
import { sortUniquePluginIds } from "./gateway-startup-plugin-contracts.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "./plugin-metadata-snapshot.types.js";
import { normalizePluginIdScope } from "./plugin-scope.js";
import {
  collectConfiguredWorkerProviderIds,
  normalizeWorkerProviderIds,
} from "./worker-provider-registry.js";

export function resolveGatewayStartupMetadataPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: InstalledPluginIndex;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const pluginsConfig = normalizePluginsConfigForInstalledIndex(params.config.plugins, lookup);
  const activationSourcePlugins = normalizePluginsConfigForInstalledIndex(
    activationSourceConfig.plugins,
    lookup,
  );
  if (!pluginsConfig.enabled || !activationSourcePlugins.enabled) {
    return [];
  }
  if (
    readStartupBundledDiscoveryMode(params.config, params.env) === "compat" ||
    readStartupBundledDiscoveryMode(activationSourceConfig, params.env) === "compat"
  ) {
    return undefined;
  }
  if (pluginsConfig.allow.length === 0 && activationSourcePlugins.allow.length === 0) {
    return undefined;
  }

  const scope = new Set<string>([...pluginsConfig.allow, ...activationSourcePlugins.allow]);
  addPluginConfigEntryIds(scope, pluginsConfig);
  addPluginConfigEntryIds(scope, activationSourcePlugins);

  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId: lookup.normalizePluginId,
  });
  addConfiguredSlotPluginIds(scope, {
    activationSourceConfig,
    activationSourcePlugins,
    lookup,
  });
  for (const pluginId of resolveAuthorizedGatewayStartupDreamingPluginIds({
    config: params.config,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    activationSourcePlugins,
    selectedMemoryPluginId: memorySlotStartupPluginId,
    index: params.index,
    platform: params.platform,
  })) {
    scope.add(pluginId);
  }
  if (!lookup.hasCompleteConfigPathActivationMetadata()) {
    return undefined;
  }
  addConfiguredActivationPathPluginIds(scope, {
    activationSourceConfig,
    index: params.index,
  });

  const configuredChannelIds = collectConfiguredStartupChannelIds({
    config: params.config,
    activationSourceConfig,
    env: params.env,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  if (!lookup.hasDirectChannelOwners(configuredChannelIds)) {
    return undefined;
  }
  lookup.addDirectChannelOwners(scope, configuredChannelIds);

  const configuredProviderIds = sortUniquePluginIds([
    ...collectConfiguredProviderIds(params.config),
    ...collectConfiguredProviderIds(activationSourceConfig),
    ...collectValidationConfiguredProviderIds(params.config),
    ...collectValidationConfiguredProviderIds(activationSourceConfig),
  ]);
  if (!lookup.canResolveDirectProviderIds(configuredProviderIds, scope)) {
    return undefined;
  }
  lookup.addDirectProviderOwners(scope, configuredProviderIds);

  const workerProviderIds = normalizeWorkerProviderIds([
    ...collectConfiguredWorkerProviderIds(params.config),
    ...collectConfiguredWorkerProviderIds(activationSourceConfig),
    ...(params.workerProviderIds ?? []),
  ]);
  if (!lookup.hasProviderContributionOwners(workerProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, workerProviderIds);

  const configuredShorthandModelIds = sortUniquePluginIds([
    ...collectValidationConfiguredShorthandModelIds(params.config),
    ...collectValidationConfiguredShorthandModelIds(activationSourceConfig),
  ]);
  if (!lookup.hasShorthandModelOwners(configuredShorthandModelIds)) {
    return undefined;
  }
  lookup.addShorthandModelOwners(scope, configuredShorthandModelIds);

  addRequiredAgentHarnessPluginIds(scope, {
    activationSourceConfig,
    config: params.config,
    index: params.index,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    env: params.env,
    platform: params.platform,
  });

  const deniedPluginIds = new Set([...pluginsConfig.deny, ...activationSourcePlugins.deny]);
  for (const pluginId of deniedPluginIds) {
    scope.delete(pluginId);
  }
  for (const [pluginId, entry] of Object.entries(pluginsConfig.entries)) {
    if (entry?.enabled === false) {
      scope.delete(pluginId);
    }
  }
  for (const [pluginId, entry] of Object.entries(activationSourcePlugins.entries)) {
    if (entry?.enabled === false) {
      scope.delete(pluginId);
    }
  }
  if (!lookup.hasInstalledPluginIds(scope)) {
    return undefined;
  }
  return sortUniquePluginIds(scope);
}

export function createGatewayStartupMetadataPluginIdScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): PluginMetadataSnapshotPluginIdScope {
  const configuredChannelIds = collectConfiguredStartupChannelIds({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig ?? params.config,
    env: params.env,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  return {
    key: hashJson({
      kind: "gateway-startup",
      config: params.config,
      activationSourceConfig: params.activationSourceConfig ?? null,
      configuredChannelIds,
      workerProviderIds,
      platform: params.platform ?? null,
      ambientEnvTriggers: params.ambientEnvTriggers ?? "allow",
    }),
    resolve: ({ index }) =>
      resolveGatewayStartupMetadataPluginIds({
        config: params.config,
        ...(params.activationSourceConfig !== undefined
          ? { activationSourceConfig: params.activationSourceConfig }
          : {}),
        env: params.env,
        index,
        ...(workerProviderIds.length > 0 ? { workerProviderIds } : {}),
        ...(params.platform !== undefined ? { platform: params.platform } : {}),
        ...(params.ambientEnvTriggers !== undefined
          ? { ambientEnvTriggers: params.ambientEnvTriggers }
          : {}),
      }),
  };
}

function addValidationPluginConfigReferences(
  target: Set<string>,
  params: {
    config: OpenClawConfig;
    pluginsConfig: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
    normalizePluginId: (pluginId: string) => string;
  },
): void {
  for (const pluginId of params.pluginsConfig.allow) {
    target.add(pluginId);
  }
  for (const pluginId of params.pluginsConfig.deny) {
    target.add(pluginId);
  }
  for (const pluginId of Object.keys(params.pluginsConfig.entries)) {
    target.add(pluginId);
  }
  const rawSlots = isRecord(params.config.plugins?.slots) ? params.config.plugins.slots : {};
  const hasExplicitMemorySlot = Object.hasOwn(rawSlots, "memory");
  const memorySlot = hasExplicitMemorySlot ? params.pluginsConfig.slots.memory : undefined;
  if (typeof memorySlot === "string") {
    target.add(params.normalizePluginId(memorySlot));
  }
  const hasExplicitContextEngineSlot = Object.hasOwn(rawSlots, "contextEngine");
  const contextEngineSlot = hasExplicitContextEngineSlot
    ? params.pluginsConfig.slots.contextEngine
    : undefined;
  if (typeof contextEngineSlot === "string" && contextEngineSlot !== "legacy") {
    target.add(params.normalizePluginId(contextEngineSlot));
  }
}

export function resolveConfigValidationMetadataPluginIds(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: InstalledPluginIndex;
  platform?: NodeJS.Platform;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const pluginsConfig = normalizePluginsConfigForInstalledIndex(params.config.plugins, lookup);
  if (
    readStartupBundledDiscoveryMode(params.config, params.env) === "compat" ||
    pluginsConfig.loadPaths.length > 0
  ) {
    return undefined;
  }

  const scope = new Set<string>();
  addValidationPluginConfigReferences(scope, {
    config: params.config,
    pluginsConfig,
    normalizePluginId: lookup.normalizePluginId,
  });
  if (!lookup.hasCompleteConfigPathActivationMetadata()) {
    return undefined;
  }
  addConfiguredActivationPathPluginIds(scope, {
    activationSourceConfig: params.config,
    index: params.index,
  });

  const configuredChannelIds = collectConfigValidationChannelIds({
    config: params.config,
    env: params.env,
  });
  if (!lookup.hasChannelContributionOwners(configuredChannelIds)) {
    return undefined;
  }
  lookup.addChannelContributionOwners(scope, configuredChannelIds);

  const configuredProviderIds = collectValidationConfiguredProviderIds(params.config);
  if (!lookup.hasProviderContributionOwners(configuredProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, configuredProviderIds);

  const configuredShorthandModelIds = collectValidationConfiguredShorthandModelIds(params.config);
  if (!lookup.hasShorthandModelOwners(configuredShorthandModelIds)) {
    return undefined;
  }
  lookup.addShorthandModelOwners(scope, configuredShorthandModelIds);

  addRequiredAgentHarnessPluginIds(scope, {
    activationSourceConfig: params.config,
    config: params.config,
    index: params.index,
    pluginsConfig,
    activationSource: {
      plugins: pluginsConfig,
      rootConfig: params.config,
    },
    env: params.env,
    platform: params.platform,
  });

  if (!lookup.hasInstalledPluginIds(scope)) {
    return undefined;
  }
  return sortUniquePluginIds(scope);
}

export function createConfigValidationMetadataPluginIdScope(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): PluginMetadataSnapshotPluginIdScope {
  const configuredChannelIds = collectConfigValidationChannelIds({
    config: params.config,
    env: params.env,
  });
  const configuredProviderIds = collectValidationConfiguredProviderIds(params.config);
  const configuredShorthandModelIds = collectValidationConfiguredShorthandModelIds(params.config);
  return {
    key: hashJson({
      kind: "config-validation",
      config: params.config,
      configuredChannelIds,
      configuredProviderIds,
      configuredShorthandModelIds,
      platform: params.platform ?? null,
    }),
    resolve: ({ index }) =>
      resolveConfigValidationMetadataPluginIds({
        config: params.config,
        env: params.env,
        index,
        ...(params.platform !== undefined ? { platform: params.platform } : {}),
      }),
  };
}

export function isMetadataSnapshotScopedForGatewayStartup(params: {
  metadataSnapshot: Pick<PluginMetadataSnapshot, "index" | "pluginIds">;
  pluginIdScope: PluginMetadataSnapshotPluginIdScope;
}): boolean {
  const expectedPluginIds = normalizePluginIdScope(
    params.pluginIdScope.resolve({ index: params.metadataSnapshot.index }),
  );
  const snapshotPluginIds = normalizePluginIdScope(params.metadataSnapshot.pluginIds);
  if (expectedPluginIds === undefined || snapshotPluginIds === undefined) {
    return expectedPluginIds === undefined && snapshotPluginIds === undefined;
  }
  if (expectedPluginIds.length === 0) {
    return snapshotPluginIds.length === 0;
  }
  const snapshotPluginIdSet = new Set(snapshotPluginIds);
  return expectedPluginIds.every((pluginId) => snapshotPluginIdSet.has(pluginId));
}
