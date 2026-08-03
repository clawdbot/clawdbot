/**
 * OpenClaw plugin tool resolver.
 *
 * This module builds runtime plugin tools from config/options, delivery context,
 * auth profiles, and the current runtime config snapshot.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { resolveApiKeyForProfile, resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  resolveApiKeyForProvider as resolveProviderAuth,
} from "./model-auth.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import { getPreparedPluginRuntimeLoadContext } from "./prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";
import type { AnyAgentTool } from "./tools/common.js";
import { hasProviderAuthForTool } from "./tools/model-config.helpers.js";

type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
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
  clientCaps?: string[];
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

  const resolveCurrentRuntimeConfig = () => {
    // Re-resolve on demand so auth/profile lookups see the active runtime config
    // while tests can still inject a fixed resolvedConfig.
    return resolveAgentRuntimeToolConfig(params.resolvedConfig ?? params.options?.config);
  };
  const pluginToolInputs = resolveOpenClawPluginToolInputs({
    options: params.options,
    resolvedConfig: params.resolvedConfig,
    runtimeConfig: resolveCurrentRuntimeConfig(),
    getRuntimeConfig: resolveCurrentRuntimeConfig,
  });
  const authProfileStore = params.options?.authProfileStore;
  const availabilityConfig = resolveCurrentRuntimeConfig();
  const availabilityRuntimeLookup = authProfileStore
    ? createRuntimeProviderAuthLookup({
        cfg: availabilityConfig,
        workspaceDir: pluginToolInputs.context.workspaceDir,
        includePluginSyntheticAuth: false,
      })
    : undefined;
  const hasAuthForProvider = authProfileStore
    ? (providerId: string) =>
        hasProviderAuthForTool({
          provider: providerId,
          cfg: availabilityConfig,
          workspaceDir: pluginToolInputs.context.workspaceDir,
          agentDir: params.options?.agentDir,
          authStore: authProfileStore,
          runtimeLookup: availabilityRuntimeLookup,
        })
    : undefined;
  const resolveApiKeyForProvider = authProfileStore
    ? async (providerId: string): Promise<string | undefined> => {
        const cfg = resolveCurrentRuntimeConfig();
        for (const profileId of resolveAuthProfileOrder({
          cfg,
          store: authProfileStore,
          provider: providerId,
        })) {
          const resolved = await resolveApiKeyForProfile({
            cfg,
            store: authProfileStore,
            profileId,
            agentDir: params.options?.agentDir,
          });
          if (resolved?.apiKey) {
            return resolved.apiKey;
          }
        }
        const workspaceDir = pluginToolInputs.context.workspaceDir;
        const runtimeLookup = createRuntimeProviderAuthLookup({
          cfg,
          workspaceDir,
          includePluginSyntheticAuth: false,
        });
        if (
          !hasRuntimeAvailableProviderAuth({
            provider: providerId,
            cfg,
            workspaceDir,
            allowPluginSyntheticAuth: false,
            runtimeLookup,
          })
        ) {
          return undefined;
        }
        try {
          const resolved = await resolveProviderAuth({
            provider: providerId,
            cfg,
            store: authProfileStore,
            agentDir: params.options?.agentDir,
            workspaceDir,
            credentialPrecedence: "env-first",
            allowAuthProfileFallback: false,
          });
          return resolved.apiKey;
        } catch {
          return undefined;
        }
      }
    : undefined;
  const existingToolNames = new Set(params.existingToolNames ?? []);
  const preparedModelRuntime = params.options?.preparedModelRuntime;
  const pluginTools = resolvePluginTools({
    ...pluginToolInputs,
    context: {
      ...pluginToolInputs.context,
      ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
      ...(resolveApiKeyForProvider ? { resolveApiKeyForProvider } : {}),
    },
    existingToolNames,
    clientCaps: params.options?.clientCaps,
    toolAllowlist: params.options?.pluginToolAllowlist,
    toolDenylist: params.options?.pluginToolDenylist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
    ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
    ...(preparedModelRuntime
      ? {
          preparedRuntime: {
            loadContext: getPreparedPluginRuntimeLoadContext(preparedModelRuntime.pluginRegistry),
            metadataSnapshot: preparedModelRuntime.metadataSnapshot,
            registry: preparedModelRuntime.pluginRegistry,
          },
        }
      : {}),
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
    deliveryContext: pluginToolInputs.context.deliveryContext,
  });
}
