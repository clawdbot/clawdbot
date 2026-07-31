// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
} from "../../plugins/runtime.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
let bootstrapRegistryGeneration: string | undefined;
const bootstrapAttemptedChannelsByConfig = new Map<string, Set<DeliverableMessageChannel>>();

function resolveBootstrapRegistryGeneration(): string {
  return `${getActivePluginChannelRegistryVersion()}:${getActivePluginRegistryVersion()}`;
}

function resolveBootstrapAttemptedChannels(cfg: OpenClawConfig): Set<DeliverableMessageChannel> {
  const registryGeneration = resolveBootstrapRegistryGeneration();
  if (registryGeneration !== bootstrapRegistryGeneration) {
    bootstrapRegistryGeneration = registryGeneration;
    bootstrapAttemptedChannelsByConfig.clear();
  }
  const configKey = resolveRuntimeConfigCacheKey(cfg);
  const existing = bootstrapAttemptedChannelsByConfig.get(configKey);
  if (existing) {
    bootstrapAttemptedChannelsByConfig.delete(configKey);
    bootstrapAttemptedChannelsByConfig.set(configKey, existing);
    return existing;
  }
  // Agent-scoped configs may interleave within one registry generation. Keep a
  // bounded LRU so one caller cannot evict another on every delivery attempt.
  if (bootstrapAttemptedChannelsByConfig.size >= MAX_BOOTSTRAP_CONFIG_GENERATIONS) {
    const oldestConfigKey = bootstrapAttemptedChannelsByConfig.keys().next().value;
    if (oldestConfigKey !== undefined) {
      bootstrapAttemptedChannelsByConfig.delete(oldestConfigKey);
    }
  }
  const attemptedChannels = new Set<DeliverableMessageChannel>();
  bootstrapAttemptedChannelsByConfig.set(configKey, attemptedChannels);
  return attemptedChannels;
}

/** Clears the per-generation channel bootstrap retry guard for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapRegistryGeneration = undefined;
  bootstrapAttemptedChannelsByConfig.clear();
}

function channelEntryCanSend(entry: PluginChannelRegistration | undefined): boolean {
  return Boolean(entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text);
}

function findChannelEntry(
  registry: ReturnType<typeof getActivePluginRegistry>,
  channel: DeliverableMessageChannel,
): PluginChannelRegistration | undefined {
  return registry?.channels?.find((entry) => entry?.plugin?.id === channel);
}

function canResolveSendCapableChannel(channel: DeliverableMessageChannel): boolean {
  const activeChannelRegistry = getActivePluginChannelRegistry();
  const channelEntry = findChannelEntry(activeChannelRegistry, channel);
  if (channelEntryCanSend(channelEntry)) {
    return true;
  }

  const activeRegistry = getActivePluginRegistry();
  if (activeRegistry && activeRegistry !== activeChannelRegistry) {
    return channelEntryCanSend(findChannelEntry(activeRegistry, channel));
  }
  return false;
}

/** Loads runtime plugins on demand when a selected outbound channel has only a setup shell. */
export function bootstrapOutboundChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  if (canResolveSendCapableChannel(params.channel)) {
    return;
  }

  const attemptedChannels = resolveBootstrapAttemptedChannels(cfg);
  if (attemptedChannels.has(params.channel)) {
    return;
  }
  attemptedChannels.add(params.channel);

  const autoEnabled = applyPluginAutoEnable({ config: cfg });
  const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
  try {
    resolveRuntimePluginRegistry({
      config: autoEnabled.config,
      activationSourceConfig: cfg,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  // A bootstrap can replace the registry itself. Adopt that generation without
  // forgetting failures for interleaved configs; external replacements observed
  // before the next attempt still clear the guard above.
  bootstrapRegistryGeneration = resolveBootstrapRegistryGeneration();
  if (!canResolveSendCapableChannel(params.channel)) {
    // Loading can replace the active registry without making this channel usable.
    // Carry the failure forward so polling callers wait for config or registry reload.
    resolveBootstrapAttemptedChannels(cfg).add(params.channel);
  }
}
