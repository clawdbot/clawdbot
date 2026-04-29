import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginRegistryIdNormalizer,
  normalizePluginsConfigWithRegistry,
} from "./plugin-registry-contributions.js";
import { loadPluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

const DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS_ENV =
  "OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS";

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldDisableLegacyImplicitStartupSidecars(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env[DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS_ENV]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isConfigActivationValueEnabled(value: unknown): boolean {
  if (value === false) {
    return false;
  }
  if (isRecord(value) && value.enabled === false) {
    return false;
  }
  return true;
}

function listPotentialEnabledChannelIds(config: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(config));
  return listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false })
    .map((id) => normalizeOptionalLowercaseString(id) ?? "")
    .filter((id) => id && !disabled.has(id));
}

function isGatewayStartupMemoryPlugin(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.startup.memory;
}

/**
 * @deprecated Compatibility fallback for plugins that do not declare
 * `activation.onStartup`. Keep this path visible so we can remove it after
 * plugin manifests migrate to explicit startup activation.
 */
function isDeprecatedLegacyImplicitStartupSidecar(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
}): boolean {
  return params.plugin.startup.sidecar && params.manifest?.activation?.onStartup === undefined;
}

function resolveGatewayStartupDreamingPluginIds(config: OpenClawConfig): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return new Set();
  }
  return new Set([DEFAULT_MEMORY_DREAMING_PLUGIN_ID, resolveMemoryDreamingPluginId(config)]);
}

function resolveMemorySlotStartupPluginId(params: {
  activationSourceConfig: OpenClawConfig;
  activationSourcePlugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  normalizePluginId: (pluginId: string) => string;
}): string | undefined {
  const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
  const configuredSlot = activationSourceConfig.plugins?.slots?.memory?.trim();
  if (configuredSlot?.toLowerCase() === "none") {
    return undefined;
  }
  if (!configuredSlot) {
    const defaultSlot = activationSourcePlugins.slots.memory;
    if (typeof defaultSlot !== "string") {
      return undefined;
    }
    if (
      activationSourcePlugins.allow.length > 0 &&
      !activationSourcePlugins.allow.includes(defaultSlot)
    ) {
      return undefined;
    }
    return defaultSlot;
  }
  return normalizePluginId(configuredSlot);
}

function shouldConsiderForGatewayStartup(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  disableLegacyImplicitStartupSidecars: boolean;
  startupDreamingPluginIds: ReadonlySet<string>;
  memorySlotStartupPluginId?: string;
}): boolean {
  if (params.manifest?.activation?.onStartup === true) {
    return true;
  }
  if (params.plugin.startup.sidecar) {
    if (params.manifest?.activation?.onStartup === false) {
      return false;
    }
    if (params.disableLegacyImplicitStartupSidecars) {
      return false;
    }
    // Deprecated compatibility fallback: plugins without explicit startup
    // activation metadata may still need startup import to register hooks or
    // services. All plugins should declare activation.onStartup explicitly as
    // we migrate away from implicit startup sidecar loading.
    return isDeprecatedLegacyImplicitStartupSidecar({
      plugin: params.plugin,
      manifest: params.manifest,
    });
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.pluginId)) {
    return true;
  }
  return params.memorySlotStartupPluginId === params.plugin.pluginId;
}

function hasConfiguredStartupChannel(params: {
  plugin: InstalledPluginIndexRecord;
  manifestRegistry: PluginManifestRegistry;
  configuredChannelIds: ReadonlySet<string>;
}): boolean {
  return listManifestChannelIds(params.manifestRegistry, params.plugin.pluginId).some((channelId) =>
    params.configuredChannelIds.has(channelId),
  );
}

function listManifestChannelIds(
  manifestRegistry: PluginManifestRegistry,
  pluginId: string,
): readonly string[] {
  return manifestRegistry.plugins.find((plugin) => plugin.id === pluginId)?.channels ?? [];
}

function findManifestPlugin(
  manifestRegistry: PluginManifestRegistry,
  pluginId: string,
): PluginManifestRecord | undefined {
  return manifestRegistry.plugins.find((plugin) => plugin.id === pluginId);
}

function hasConfiguredActivationPath(params: {
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
}): boolean {
  const paths = params.manifest?.activation?.onConfigPaths;
  if (!paths?.length) {
    return false;
  }
  return paths.some((pathPattern) =>
    collectPluginConfigContractMatches({
      root: params.config,
      pathPattern,
    }).some((match) => isConfigActivationValueEnabled(match.value)),
  );
}

function canStartConfiguredRootPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSourcePlugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
}): boolean {
  if (params.plugin.origin !== "bundled") {
    return false;
  }
  if (!hasConfiguredActivationPath({ manifest: params.manifest, config: params.config })) {
    return false;
  }
  if (!params.pluginsConfig.enabled || !params.activationSourcePlugins.enabled) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSourcePlugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSourcePlugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  return true;
}

function canStartConfiguredChannelPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  manifestRegistry: PluginManifestRegistry;
}): boolean {
  if (!params.pluginsConfig.enabled) {
    return false;
  }
  if (params.pluginsConfig.deny.includes(params.plugin.pluginId)) {
    return false;
  }
  if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false) {
    return false;
  }
  const explicitBundledChannelConfig =
    params.plugin.origin === "bundled" &&
    listManifestChannelIds(params.manifestRegistry, params.plugin.pluginId).some((channelId) =>
      hasExplicitChannelConfig({
        config: params.activationSource.rootConfig ?? params.config,
        channelId,
      }),
    );
  if (
    params.pluginsConfig.allow.length > 0 &&
    !params.pluginsConfig.allow.includes(params.plugin.pluginId) &&
    !explicitBundledChannelConfig
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: params.plugin.enabledByDefault,
    activationSource: params.activationSource,
  });
  return activationState.enabled && activationState.explicitlyEnabled;
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  return resolveChannelPluginIdsFromRegistry({ manifestRegistry });
}

export function resolveChannelPluginIdsFromRegistry(params: {
  manifestRegistry: PluginManifestRegistry;
}): string[] {
  const { manifestRegistry } = params;
  return manifestRegistry.plugins
    .filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredDeferredChannelPluginIdsFromRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: ReturnType<typeof loadPluginRegistrySnapshot>;
  manifestRegistry: PluginManifestRegistry;
}): string[] {
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  if (configuredChannelIds.size === 0) {
    return [];
  }
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  const activationSource = {
    plugins: pluginsConfig,
    rootConfig: params.config,
  };
  return params.index.plugins
    .filter(
      (plugin) =>
        hasConfiguredStartupChannel({
          plugin,
          manifestRegistry: params.manifestRegistry,
          configuredChannelIds,
        }) &&
        plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen &&
        canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestRegistry: params.manifestRegistry,
        }),
    )
    .map((plugin) => plugin.pluginId);
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  return resolveConfiguredDeferredChannelPluginIdsFromRegistry({
    config: params.config,
    env: params.env,
    index,
    manifestRegistry,
  });
}

export function resolveGatewayStartupPluginIdsFromRegistry(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: ReturnType<typeof loadPluginRegistrySnapshot>;
  manifestRegistry: PluginManifestRegistry;
}): string[] {
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const activationSourcePlugins = normalizePluginsConfigWithRegistry(
    activationSourceConfig.plugins,
    params.index,
    { manifestRegistry: params.manifestRegistry },
  );
  const activationSource = {
    plugins: activationSourcePlugins,
    rootConfig: activationSourceConfig,
  };
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig, params.env),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const disableLegacyImplicitStartupSidecars = shouldDisableLegacyImplicitStartupSidecars(
    params.env,
  );
  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId: createPluginRegistryIdNormalizer(params.index, {
      manifestRegistry: params.manifestRegistry,
    }),
  });
  return params.index.plugins
    .filter((plugin) => {
      const manifest = findManifestPlugin(params.manifestRegistry, plugin.pluginId);
      if (
        hasConfiguredStartupChannel({
          plugin,
          manifestRegistry: params.manifestRegistry,
          configuredChannelIds,
        })
      ) {
        return canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestRegistry: params.manifestRegistry,
        });
      }
      if (
        plugin.startup.agentHarnesses.some((runtime) => requiredAgentHarnessRuntimes.has(runtime))
      ) {
        const activationState = resolveEffectivePluginActivationState({
          id: plugin.pluginId,
          origin: plugin.origin,
          config: pluginsConfig,
          rootConfig: params.config,
          enabledByDefault: plugin.enabledByDefault,
          activationSource,
        });
        return activationState.enabled;
      }
      if (
        canStartConfiguredRootPlugin({
          plugin,
          manifest,
          config: activationSourceConfig,
          pluginsConfig,
          activationSourcePlugins,
        })
      ) {
        return true;
      }
      if (
        !shouldConsiderForGatewayStartup({
          plugin,
          manifest,
          disableLegacyImplicitStartupSidecars,
          startupDreamingPluginIds,
          memorySlotStartupPluginId,
        })
      ) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: pluginsConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
        activationSource,
      });
      if (!activationState.enabled) {
        return false;
      }
      if (plugin.origin !== "bundled") {
        return activationState.explicitlyEnabled;
      }
      return activationState.source === "explicit" || activationState.source === "default";
    })
    .map((plugin) => plugin.pluginId);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  return resolveGatewayStartupPluginIdsFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index,
    manifestRegistry,
  });
}
