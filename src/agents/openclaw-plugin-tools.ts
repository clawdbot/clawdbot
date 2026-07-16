/**
 * OpenClaw plugin tool resolver.
 *
 * This module builds runtime plugin tools from config/options, delivery context,
 * auth profiles, and the current runtime config snapshot.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveApiKeyForProfile, resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";
import type { AnyAgentTool } from "./tools/common.js";

type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  sandboxRoot?: string;
  modelHasVision?: boolean;
  modelProvider?: string;
  modelId?: string;
  allowMediaInvokeCommands?: boolean;
  requesterAgentIdOverride?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  disablePluginTools?: boolean;
  authProfileStore?: AuthProfileStore;
};

/** Resolves plugin tools for an agent run and applies delivery-context defaults. */
export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  if (params.options?.disablePluginTools) {
    return [];
  }

  const deliveryContext = normalizeDeliveryContext({
    channel: params.options?.agentChannel,
    to: params.options?.agentTo,
    accountId: params.options?.agentAccountId,
    threadId: params.options?.agentThreadId,
  });

  const resolveCurrentRuntimeConfig = () => {
    // Re-resolve on demand so auth/profile lookups see the active runtime config
    // while tests can still inject a fixed resolvedConfig.
    return resolveAgentRuntimeToolConfig(params.resolvedConfig ?? params.options?.config);
  };
  const authProfileStore = params.options?.authProfileStore;
  const resolveAuthProfileIdsForProvider = authProfileStore
    ? (providerId: string): string[] =>
        resolveAuthProfileOrder({
          cfg: resolveCurrentRuntimeConfig(),
          store: authProfileStore,
          provider: providerId,
        })
    : undefined;
  const hasAuthForProvider = authProfileStore
    ? (providerId: string) => (resolveAuthProfileIdsForProvider?.(providerId) ?? []).length > 0
    : undefined;
  const resolveApiKeyForProvider = authProfileStore
    ? async (providerId: string): Promise<string | undefined> => {
        for (const profileId of resolveAuthProfileIdsForProvider?.(providerId) ?? []) {
          const resolved = await resolveApiKeyForProfile({
            cfg: resolveCurrentRuntimeConfig(),
            store: authProfileStore,
            profileId,
            agentDir: params.options?.agentDir,
          });
          if (resolved?.apiKey) {
            return resolved.apiKey;
          }
        }
        return undefined;
      }
    : undefined;
  const pluginToolInputs = resolveOpenClawPluginToolInputs({
    options: params.options,
    resolvedConfig: params.resolvedConfig,
    runtimeConfig: resolveCurrentRuntimeConfig(),
    getRuntimeConfig: resolveCurrentRuntimeConfig,
  });
  const existingToolNames = new Set(params.existingToolNames ?? []);
  const pluginTools = resolvePluginTools({
    ...pluginToolInputs,
    context: {
      ...pluginToolInputs.context,
      ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
      ...(resolveApiKeyForProvider ? { resolveApiKeyForProvider } : {}),
    },
    existingToolNames,
    toolAllowlist: params.options?.pluginToolAllowlist,
    toolDenylist: params.options?.pluginToolDenylist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
    ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
  });
  for (const tool of pluginTools) {
    existingToolNames.add(tool.name);
  }
  pluginTools.push(
    ...createNodePluginTools({
      existingToolNames,
      toolAllowlist: params.options?.pluginToolAllowlist,
      toolDenylist: params.options?.pluginToolDenylist,
      agentSessionKey: params.options?.agentSessionKey,
    }),
  );

  return applyPluginToolDeliveryDefaults({
    tools: pluginTools,
    deliveryContext,
  });
}
