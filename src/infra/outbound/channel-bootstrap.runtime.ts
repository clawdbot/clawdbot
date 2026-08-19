// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { pruneMapToMaxSize } from "../map-size.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
const MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG = 64;
let bootstrapRegistryGeneration: string | undefined;
const bootstrapRegistriesByConfig = new Map<string, Map<string, PluginRegistry | null>>();

function cacheBootstrapOutcome(
  registries: Map<string, PluginRegistry | null>,
  key: string,
  outcome: PluginRegistry | null,
): void {
  // Reinsert every outcome, including null, so reads and writes share LRU ordering.
  registries.delete(key);
  registries.set(key, outcome);
  pruneMapToMaxSize(registries, MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG);
}

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
  agentId?: string;
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

  // Outbound callers already know the admitted run owner. Preserve it here so
  // explicit fleets do not fall back to forbidden ambient-agent selection.
  // Agent-less sends route through the configured ambient owner (legacy
  // default, then systemAgent); ownerless fleets never throw — startup
  // delivery recovery runs this path — and bootstrap with global-scope
  // plugin discovery only. normalizeAgentId never returns "", so "" is a
  // collision-free ownerless cache slot.
  const agentId = params.agentId?.trim()
    ? normalizeAgentId(params.agentId)
    : tryResolveAmbientOwnerAgentId(cfg);
  const outcomeKey = `${agentId ?? ""}\0${params.channel}`;
  const registries = resolveBootstrapRegistries(cfg);
  const cachedRegistry = registries.get(outcomeKey);
  if (cachedRegistry !== undefined) {
    cacheBootstrapOutcome(registries, outcomeKey, cachedRegistry);
    return resolveSendCapableRegistry(cachedRegistry, params.channel);
  }

  const autoEnabled = applyPluginAutoEnable({ config: cfg });
  const workspaceDir = agentId === undefined ? undefined : resolveAgentWorkspaceDir(cfg, agentId);
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
  let sendRegistry: PluginRegistry | undefined;
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
    sendRegistry = resolveSendCapableRegistry(registry, params.channel);
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  cacheBootstrapOutcome(registries, outcomeKey, sendRegistry ?? null);
  return sendRegistry;
}
