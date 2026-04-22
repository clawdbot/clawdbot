import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import {
  createPluginActivationSource,
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { hasKind } from "./slots.js";

function hasRuntimeContractSurface(plugin: PluginManifestRecord): boolean {
  return Boolean(
    plugin.providers.length > 0 ||
    plugin.cliBackends.length > 0 ||
    plugin.contracts?.speechProviders?.length ||
    plugin.contracts?.mediaUnderstandingProviders?.length ||
    plugin.contracts?.imageGenerationProviders?.length ||
    plugin.contracts?.videoGenerationProviders?.length ||
    plugin.contracts?.musicGenerationProviders?.length ||
    plugin.contracts?.webFetchProviders?.length ||
    plugin.contracts?.webSearchProviders?.length ||
    plugin.contracts?.memoryEmbeddingProviders?.length ||
    hasKind(plugin.kind, "memory"),
  );
}

function isGatewayStartupMemoryPlugin(plugin: PluginManifestRecord): boolean {
  return hasKind(plugin.kind, "memory");
}

function isGatewayStartupSidecar(plugin: PluginManifestRecord): boolean {
  return plugin.channels.length === 0 && !hasRuntimeContractSurface(plugin);
}

function resolveGatewayStartupDreamingPluginIds(config: OpenClawConfig): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return new Set();
  }
  return new Set(["memory-core", resolveMemoryDreamingPluginId(config)]);
}

function resolveExplicitMemorySlotStartupPluginId(config: OpenClawConfig): string | undefined {
  const configuredSlot = config.plugins?.slots?.memory?.trim();
  if (!configuredSlot || configuredSlot.toLowerCase() === "none") {
    return undefined;
  }
  return normalizePluginId(configuredSlot);
}

function shouldConsiderForGatewayStartup(params: {
  plugin: PluginManifestRecord;
  startupDreamingPluginIds: ReadonlySet<string>;
  explicitMemorySlotStartupPluginId?: string;
}): boolean {
  if (isGatewayStartupSidecar(params.plugin)) {
    return true;
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.id)) {
    return true;
  }
  return params.explicitMemorySlotStartupPluginId === params.plugin.id;
}

function hasConfiguredStartupChannel(params: {
  plugin: PluginManifestRecord;
  configuredChannelIds: ReadonlySet<string>;
}): boolean {
  return params.plugin.channels.some((channelId) => params.configuredChannelIds.has(channelId));
}

function canStartConfiguredChannelPlugin(params: {
  plugin: PluginManifestRecord;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfig>;
  activationSource: ReturnType<typeof createPluginActivationSource>;
}): boolean {
  if (!params.pluginsConfig.enabled) {
    return false;
  }
  if (params.pluginsConfig.deny.includes(params.plugin.id)) {
    return false;
  }
  if (params.pluginsConfig.entries[params.plugin.id]?.enabled === false) {
    return false;
  }
  const explicitBundledChannelConfig =
    params.plugin.origin === "bundled" &&
    params.plugin.channels.some((channelId) =>
      hasExplicitChannelConfig({
        config: params.activationSource.rootConfig ?? params.config,
        channelId,
      }),
    );
  if (
    params.pluginsConfig.allow.length > 0 &&
    !params.pluginsConfig.allow.includes(params.plugin.id) &&
    !explicitBundledChannelConfig
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.id,
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
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  const activationSource = createPluginActivationSource({
    config: params.config,
  });
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        hasConfiguredStartupChannel({ plugin, configuredChannelIds }) &&
        plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true &&
        canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
        }),
    )
    .map((plugin) => plugin.id);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const requiredAgentHarnessPluginIds = new Set(
    collectConfiguredAgentHarnessRuntimes(
      params.activationSourceConfig ?? params.config,
      params.env,
    ).flatMap((runtime) =>
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: true,
      }),
    ),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const explicitMemorySlotStartupPluginId = resolveExplicitMemorySlotStartupPluginId(
    params.activationSourceConfig ?? params.config,
  );
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => {
      if (hasConfiguredStartupChannel({ plugin, configuredChannelIds })) {
        return canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
        });
      }
      if (requiredAgentHarnessPluginIds.has(plugin.id)) {
        const activationState = resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: pluginsConfig,
          rootConfig: params.config,
          enabledByDefault: plugin.enabledByDefault,
          activationSource,
        });
        return activationState.enabled;
      }
      if (
        !shouldConsiderForGatewayStartup({
          plugin,
          startupDreamingPluginIds,
          explicitMemorySlotStartupPluginId,
        })
      ) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.id,
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
    .map((plugin) => plugin.id);
}
