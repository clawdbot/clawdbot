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
import { loadPluginRegistryHandle, type PluginRegistryHandle } from "../../plugins/loader.js";
import { PluginLruCache } from "../../plugins/plugin-cache-primitives.js";
import {
  requirePluginRegistryResourceScope,
  retainPluginRegistryResources,
} from "../../plugins/registry-resources.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
const MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG = 64;
type BootstrapRegistryCache = PluginLruCache<PluginRegistryHandle | null>;
const bootstrapState = resolveGlobalSingleton<{
  generation?: string;
  registries: PluginLruCache<BootstrapRegistryCache>;
}>(
  Symbol.for("openclaw.outboundChannelBootstrapHost"),
  () => ({
    registries: new PluginLruCache<BootstrapRegistryCache>(
      MAX_BOOTSTRAP_CONFIG_GENERATIONS,
      (registries) => registries.clear(),
    ),
  }),
  (state) => {
    state.generation = undefined;
    state.registries.clear();
  },
);

function cacheBootstrapOutcome(
  registries: BootstrapRegistryCache,
  key: string,
  outcome: PluginRegistry | null,
): void {
  registries.set(
    key,
    outcome ? { registry: outcome, ...retainPluginRegistryResources(outcome) } : null,
  );
}

function resolveBootstrapRegistryGeneration(): string {
  return String(getActivePluginRegistryVersion());
}

function resolveBootstrapRegistries(cfg: OpenClawConfig): BootstrapRegistryCache {
  const registryGeneration = resolveBootstrapRegistryGeneration();
  if (registryGeneration !== bootstrapState.generation) {
    bootstrapState.generation = registryGeneration;
    bootstrapState.registries.clear();
  }
  const configKey = resolveRuntimeConfigCacheKey(cfg);
  const existing = bootstrapState.registries.get(configKey);
  if (existing) {
    return existing;
  }
  // Agent-scoped configs may interleave within one registry generation. Keep a
  // bounded LRU so one caller cannot evict another on every delivery attempt.
  const registries = new PluginLruCache<PluginRegistryHandle | null>(
    MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG,
    (handle) => handle?.release(),
  );
  bootstrapState.registries.set(configKey, registries);
  return registries;
}

/** Clears the per-generation channel bootstrap handle cache for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapState.generation = undefined;
  bootstrapState.registries.clear();
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

  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedEntry = findChannelEntry(scopedRegistry ?? null, params.channel);
  const activeRegistry = scopedEntry ? scopedRegistry : getActivePluginRegistry();
  const activeSendRegistry = resolveSendCapableRegistry(activeRegistry, params.channel);
  if (activeSendRegistry) {
    return activeSendRegistry;
  }

  // Outbound callers already know the admitted run owner. Preserve it here so
  // explicit fleets do not fall back to forbidden ambient-agent selection.
  // Agent-less sends route through the configured ambient owner (systemAgent,
  // then the legacy default); ownerless fleets never throw — startup
  // delivery recovery runs this path — and bootstrap with global-scope
  // plugin discovery only. Normalized agent ids never equal "", so "" is a
  // collision-free ownerless cache slot.
  const agentId = tryResolveAmbientOwnerAgentId(cfg, params.agentId);
  const outcomeKey = `${agentId ?? ""}\0${params.channel}`;
  // Root-generation memoization cannot replace a selected scoped setup owner.
  // Its activation uses the loader's own registry-handle cache instead.
  const registries = scopedEntry ? undefined : resolveBootstrapRegistries(cfg);
  if (registries) {
    const cachedRegistry = registries.get(outcomeKey);
    if (cachedRegistry !== undefined) {
      if (cachedRegistry) {
        requirePluginRegistryResourceScope().retain(cachedRegistry.registry);
      }
      return resolveSendCapableRegistry(cachedRegistry?.registry, params.channel);
    }
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
  const resources = requirePluginRegistryResourceScope();
  try {
    const registry = resources.adopt(
      loadPluginRegistryHandle({
        config: activatedConfig,
        activationSourceConfig: activatedSourceConfig,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        onlyPluginIds: pluginIds,
        workspaceDir,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    );
    sendRegistry = resolveSendCapableRegistry(registry, params.channel);
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  if (registries) {
    cacheBootstrapOutcome(registries, outcomeKey, sendRegistry ?? null);
  }
  return sendRegistry;
}
