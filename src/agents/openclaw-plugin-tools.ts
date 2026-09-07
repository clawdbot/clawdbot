/**
 * OpenClaw plugin tool resolver.
 *
 * This module builds runtime plugin tools from config/options, delivery context,
 * auth profiles, and the current runtime config snapshot.
 */
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMessageActionTurnCapability,
  selectMessageActionRequesterIdentity,
} from "../gateway/message-action-turn-capability.js";
import { resolveAgentScopedOutboundMediaAccess } from "../media/read-capability.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { OpenClawPluginToolDelivery } from "../plugins/tool-types.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveApiKeyForProfile, resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
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

const loadMessageActionRunner = createLazyRuntimeModule(
  () => import("../infra/outbound/message-action-runner.js"),
);

function createPluginToolDelivery(params: {
  options: ResolveOpenClawPluginToolsOptions | undefined;
  context: OpenClawPluginToolContext;
  bindingConfig: OpenClawConfig | undefined;
  resolveConfig: () => OpenClawConfig | undefined;
}): OpenClawPluginToolDelivery | undefined {
  const deliveryContext = params.context.deliveryContext;
  const agentId = params.context.agentId;
  const sessionKey = params.context.sessionKey;
  const sessionId = params.context.sessionId;
  const senderIsOwner = params.context.senderIsOwner;
  const conversationReadOrigin = params.context.conversationReadOrigin;
  const runId = params.options?.runId;
  const token = params.options?.messageActionTurnCapability;
  const activeRegistry = getActivePluginRegistry();
  const activeRegistryVersion = getActivePluginRegistryVersion();
  if (
    !deliveryContext?.channel ||
    !deliveryContext.to ||
    !agentId ||
    !sessionKey ||
    !runId ||
    !token ||
    !activeRegistry
  ) {
    return undefined;
  }
  // Capabilities bind the source policy session, even when plugins execute in
  // a shared or durable session. Keep validation separate from execution identity.
  const policySessionKey = params.options?.agentSessionKey ?? sessionKey;
  const channelPlugin = activeRegistry.channels.find(
    (entry) => entry.plugin.id === deliveryContext.channel,
  )?.plugin;
  // The turn capability and sender-scoped media reader are process-local.
  // Gateway-owned delivery needs a server-verifiable authority contract first.
  if (channelPlugin?.outbound?.deliveryMode === "gateway") {
    return undefined;
  }
  const route = {
    channel: deliveryContext.channel,
    to: deliveryContext.to,
    accountId: deliveryContext.accountId,
    threadId: deliveryContext.threadId,
  };

  const resolveAuthorization = () => {
    if (
      getActivePluginRegistry() !== activeRegistry ||
      getActivePluginRegistryVersion() !== activeRegistryVersion
    ) {
      throw new Error("plugin delivery capability is no longer active");
    }
    const authorization = resolveMessageActionTurnCapability({
      token,
      agentId,
      runId,
      sessionKey: policySessionKey,
      sessionId,
    });
    if (!authorization) {
      throw new Error("plugin delivery capability is no longer active");
    }
    return authorization;
  };
  const bindingAuthorization = resolveAuthorization();
  const bindingConfig = params.bindingConfig;
  if (!bindingConfig) {
    return undefined;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: bindingConfig,
    agentId,
    workspaceDir: params.context.workspaceDir,
    sessionKey,
    accountId: bindingAuthorization.requesterAccountId ?? route.accountId,
    requesterSenderId: bindingAuthorization.requesterSenderId,
    requesterSenderName: bindingAuthorization.requesterSenderName,
    requesterSenderUsername: bindingAuthorization.requesterSenderUsername,
    requesterSenderE164: bindingAuthorization.requesterSenderE164,
  });

  return {
    send: async ({ text, mediaUrl }) => {
      resolveAuthorization();
      const { runMessageAction } = await loadMessageActionRunner();
      const authorization = resolveAuthorization();
      const cfg = params.resolveConfig();
      if (!cfg) {
        throw new Error("plugin delivery requires an active runtime config");
      }
      await withPluginRuntimeRegistryScope(activeRegistry, () =>
        runMessageAction({
          cfg,
          action: "send",
          params: {
            channel: route.channel,
            target: route.to,
            ...(route.accountId ? { accountId: route.accountId } : {}),
            ...(route.threadId != null ? { threadId: route.threadId } : {}),
            ...(text !== undefined ? { message: text } : {}),
            ...(mediaUrl !== undefined ? { mediaUrl } : {}),
          },
          defaultAccountId: route.accountId,
          ...selectMessageActionRequesterIdentity(authorization),
          messageActionAuthorization: {
            requesterAccountId: authorization.requesterAccountId,
            requesterSenderId: authorization.requesterSenderId,
            toolContext: authorization.toolContext,
          },
          senderIsOwner,
          conversationReadOrigin,
          toolContext: authorization.toolContext,
          sessionKey,
          sessionId,
          runId,
          agentId,
          mediaAccess,
          onPlatformSendDispatch: async () => {
            resolveAuthorization();
          },
          forceCoreDelivery: true,
          skipQueue: true,
          dryRun: false,
        }),
      );
      resolveAuthorization();
    },
  };
}

/** Resolves plugin tools and their delivery context for an agent run. */
export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  if (params.options?.disablePluginTools) {
    return [];
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
  const delivery = createPluginToolDelivery({
    options: params.options,
    context: pluginToolInputs.context,
    bindingConfig: availabilityConfig,
    resolveConfig: resolveCurrentRuntimeConfig,
  });
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

  return pluginTools;
}
