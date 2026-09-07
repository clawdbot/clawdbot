/**
 * OpenClaw plugin tool resolver.
 *
 * This module builds runtime plugin tools from config/options, delivery context,
 * auth profiles, and the current runtime config snapshot.
 */
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { OpenClawPluginToolDelivery } from "../plugins/tool-types.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { resolveApiKeyForProfile, resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createCurrentTurnDelivery,
  createCurrentTurnDeliveryTool,
  type CurrentTurnDeliveryToolRef,
} from "./current-turn-delivery.js";
import {
  createRuntimeProviderAuthLookup,
  hasRuntimeAvailableProviderAuth,
  resolveApiKeyForProviderCore as resolveProviderAuth,
} from "./model-auth.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
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

/** Resolves plugin tools and their delivery context for an agent run. */
export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
  currentTurnDeliveryToolRef?: CurrentTurnDeliveryToolRef;
}): AnyAgentTool[] {
  if (params.currentTurnDeliveryToolRef) {
    delete params.currentTurnDeliveryToolRef.value;
  }

  const inputConfig = params.resolvedConfig ?? params.options?.config;
  const availabilityConfig = resolveAgentRuntimeToolConfig(inputConfig);
  // Bind ownership before reload replaces the source snapshot. Explicit run
  // overrides stay isolated; runtime-owned contexts follow later publications.
  const followsRuntimeConfig =
    inputConfig === undefined || availabilityConfig === getRuntimeConfigSnapshot();
  const resolveCurrentRuntimeConfig = () =>
    followsRuntimeConfig ? resolveAgentRuntimeToolConfig() : availabilityConfig;
  const pluginToolInputs = resolveOpenClawPluginToolInputs({
    options: params.options,
    resolvedConfig: params.resolvedConfig,
    runtimeConfig: availabilityConfig,
    getRuntimeConfig: resolveCurrentRuntimeConfig,
  });
  const authProfileStore = params.options?.authProfileStore;
  const currentTurnDelivery = createCurrentTurnDelivery({
    context: pluginToolInputs.context,
    agentSessionKey: params.options?.agentSessionKey,
    runId: params.options?.runId,
    token: params.options?.messageActionTurnCapability,
    revokedErrorMessage: "plugin delivery capability is no longer active",
  });
  const currentTurnDeliveryTool =
    params.options?.includeCurrentTurnDeliveryTool && currentTurnDelivery
      ? createCurrentTurnDeliveryTool(currentTurnDelivery)
      : undefined;
  if (currentTurnDeliveryTool && params.currentTurnDeliveryToolRef) {
    params.currentTurnDeliveryToolRef.value = currentTurnDeliveryTool;
  }
  if (params.options?.disablePluginTools) {
    return currentTurnDeliveryTool ? [currentTurnDeliveryTool] : [];
  }
  const delivery: OpenClawPluginToolDelivery | undefined = currentTurnDelivery
    ? {
        send: async (input) => {
          const result = await currentTurnDelivery.send(input);
          if (
            result.status !== "sent" &&
            result.status !== "suppressed" &&
            result.status !== "not_sent"
          ) {
            const error = new Error(result.error ?? "Plugin delivery failed.");
            if (result.sentBeforeError) {
              Object.assign(error, { sentBeforeError: true });
            }
            throw error;
          }
        },
      }
    : undefined;
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
  if (currentTurnDeliveryTool) {
    existingToolNames.add(currentTurnDeliveryTool.name);
  }
  const preparedModelRuntime = params.options?.preparedModelRuntime;
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const runtimeRegistry = requestRegistry ?? getActivePluginRegistry() ?? undefined;
  // A scoped registry can own prepared plugin facts without a model runtime (headless cron).
  // Never borrow process-global load facts for an unrelated direct caller.
  const preparedRegistry = preparedModelRuntime
    ? preparedModelRuntime.pluginRegistry
    : requestRegistry;
  const loadContext = getPluginRuntimeLoadContext(preparedRegistry);
  const metadataSnapshot = preparedModelRuntime?.metadataSnapshot ?? loadContext?.metadataSnapshot;
  const pluginTools = resolvePluginTools({
    ...pluginToolInputs,
    context: {
      ...pluginToolInputs.context,
      ...(delivery ? { delivery } : {}),
      ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
      ...(resolveApiKeyForProvider ? { resolveApiKeyForProvider } : {}),
    },
    existingToolNames,
    clientCaps: params.options?.clientCaps,
    toolAllowlist: params.options?.pluginToolAllowlist,
    toolDenylist: params.options?.pluginToolDenylist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
    ...(hasAuthForProvider ? { hasAuthForProvider } : {}),
    ...(runtimeRegistry ? { runtimeRegistry } : {}),
    ...(metadataSnapshot
      ? {
          preparedRuntime: {
            loadContext,
            metadataSnapshot,
            registry: preparedRegistry,
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
      agentSessionKey: pluginToolInputs.context.sessionKey,
    }),
  );
  if (currentTurnDeliveryTool) {
    pluginTools.push(currentTurnDeliveryTool);
  }

  return pluginTools;
}
