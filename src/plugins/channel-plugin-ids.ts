import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  createPluginActivationSource,
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
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

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function normalizeChannelIds(channelIds: Iterable<string>): string[] {
  return Array.from(
    new Set(
      [...channelIds]
        .map((channelId) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId): channelId is string => Boolean(channelId)),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
}

function isChannelPluginEligibleForScopedOwnership(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig: OpenClawConfig;
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.plugin)) {
    return true;
  }
  if (params.plugin.origin === "global" || params.plugin.origin === "config") {
    return hasExplicitManifestOwnerTrust({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    });
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

function resolveScopedChannelOwnerPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  const channelIds = normalizeChannelIds(params.channelIds);
  if (channelIds.length === 0) {
    return [];
  }
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  });
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const candidateIds = dedupeSortedPluginIds(
    channelIds.flatMap((channelId) => {
      return resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: channelId,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
      });
    }),
  );
  if (candidateIds.length === 0) {
    return [];
  }
  const candidateIdSet = new Set(candidateIds);
  return registry.plugins
    .filter((plugin) => {
      if (!candidateIdSet.has(plugin.id)) {
        return false;
      }
      return isChannelPluginEligibleForScopedOwnership({
        plugin,
        normalizedConfig,
        rootConfig: trustConfig,
      });
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

export function resolveDiscoverableScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
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

export function resolveConfiguredChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return resolveScopedChannelPluginIds({
    ...params,
    channelIds: [...configuredChannelIds],
  });
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
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.channels.some((channelId) => configuredChannelIds.has(channelId)) &&
        plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
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
      if (plugin.channels.some((channelId) => configuredChannelIds.has(channelId))) {
        return true;
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
