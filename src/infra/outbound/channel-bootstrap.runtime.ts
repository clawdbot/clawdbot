// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
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

const bootstrapAttempts = new Set<string>();

/** Clears the per-registry channel bootstrap retry guard for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapAttempts.clear();
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

  const attemptKey = `${getActivePluginChannelRegistryVersion()}:${getActivePluginRegistryVersion()}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  // Retry once per registry version/channel; failed loads clear the guard below
  // so config fixes in the same process can try again.
  bootstrapAttempts.add(attemptKey);

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
    if (!canResolveSendCapableChannel(params.channel)) {
      bootstrapAttempts.delete(attemptKey);
    }
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}
