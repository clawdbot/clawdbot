// Builds deterministic metadata scopes for startup planning.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { addRequiredAgentHarnessPluginIds } from "./gateway-startup-plugin-activation.js";
import {
  addConfiguredActivationPathPluginIds,
  addConfiguredSlotPluginIds,
  addPluginConfigEntryIds,
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
import type { PluginMetadataSnapshotPluginIdScope } from "./plugin-metadata-snapshot.types.js";
import { collectConfiguredWorkerProviderIds } from "./worker-provider-config.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

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
    includePersistedAuthState: false,
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
    includePersistedAuthState: false,
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
