// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { pruneMapToMaxSize } from "../map-size.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
let bootstrapRegistryGeneration: string | undefined;
const bootstrapRegistriesByConfig = new Map<string, Map<string, PluginRegistry | null>>();

function resolveBootstrapRegistryGeneration(): string {
  return String(getActivePluginRegistryVersion());
}

function resolveBootstrapRegistries(cfg: OpenClawConfig): Map<string, PluginRegistry | null> {
  const registryGeneration = resolveBootstrapRegistryGeneration();
  if (registryGeneration !== bootstrapRegistryGeneration) {
    bootstrapRegistryGeneration = registryGeneration;
    bootstrapRegistriesByConfig.clear();
  }
  const configKey = resolveRuntimeConfigCacheKey(cfg);
  const existing = bootstrapRegistriesByConfig.get(configKey);
  if (existing) {
    bootstrapRegistriesByConfig.delete(configKey);
    bootstrapRegistriesByConfig.set(configKey, existing);
    return existing;
  }
  // Agent-scoped configs may interleave within one registry generation. Keep a
  // bounded LRU so one caller cannot evict another on every delivery attempt.
  pruneMapToMaxSize(bootstrapRegistriesByConfig, MAX_BOOTSTRAP_CONFIG_GENERATIONS - 1);
  const registries = new Map<string, PluginRegistry | null>();
  bootstrapRegistriesByConfig.set(configKey, registries);
  return registries;
}

/** Clears the per-generation channel bootstrap handle cache for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapRegistryGeneration = undefined;
  bootstrapRegistriesByConfig.clear();
}

function channelEntryCanSend(entry: PluginChannelRegistration | undefined): boolean {
  return Boolean(entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text);
}

function findChannelEntry(
  registry: ReturnType<typeof getActivePluginRegistry>,
  channel: string,
): PluginChannelRegistration | undefined {
  return registry?.channels?.find((entry) => entry?.plugin?.id === channel);
}

function resolveSendCapableRegistry(
  registry: PluginRegistry | null | undefined,
  channel: string,
): PluginRegistry | undefined {
  return registry && channelEntryCanSend(findChannelEntry(registry, channel))
    ? registry
    : undefined;
}

/** Loads runtime plugins on demand when a selected outbound channel has only a setup shell. */
export function bootstrapOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): PluginRegistry | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }

  const activeRegistry = getActivePluginRegistry();
  const activeSendRegistry = resolveSendCapableRegistry(activeRegistry, params.channel);
  if (activeSendRegistry) {
    return activeSendRegistry;
  }

  const registries = resolveBootstrapRegistries(cfg);
  if (registries.has(params.channel)) {
    return resolveSendCapableRegistry(registries.get(params.channel), params.channel);
  }

  const autoEnabled = applyPluginAutoEnable({ config: cfg });
  const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
  const pluginIds = resolveDiscoverableScopedChannelPluginIds({
    config: autoEnabled.config,
    activationSourceConfig: cfg,
    channelIds: [params.channel],
    workspaceDir,
    env: process.env,
  });
  const activatedConfig =
    withActivatedPluginIds({ config: autoEnabled.config, pluginIds }) ?? autoEnabled.config;
  const activatedSourceConfig = withActivatedPluginIds({ config: cfg, pluginIds }) ?? cfg;
  try {
    const registry = loadPluginRegistryHandle({
      config: activatedConfig,
      activationSourceConfig: activatedSourceConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      onlyPluginIds: pluginIds,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    const sendRegistry = resolveSendCapableRegistry(registry, params.channel);
    registries.set(params.channel, sendRegistry ?? null);
    return sendRegistry;
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
    registries.set(params.channel, null);
    return undefined;
  }
}
