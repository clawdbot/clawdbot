import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
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

/** Loads runtime plugins on demand when a selected outbound channel has only a setup shell. */
export function bootstrapOutboundChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  const activeChannelRegistry = getActivePluginChannelRegistry();
  const activeChannelEntry = activeChannelRegistry?.channels?.find(
    (entry) => entry?.plugin?.id === params.channel,
  );
  if (channelEntryCanSend(activeChannelEntry)) {
    return;
  }

  const attemptKey = `${getActivePluginChannelRegistryVersion()}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
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
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}
