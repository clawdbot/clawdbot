import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../channels/plugins/conversation-read-origin.js";
/**
 * Runtime context resolver for OpenClaw plugin tools.
 *
 * Normalizes workspace, delivery, browser, sandbox, and active-model inputs before plugin tool invocation.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { modelKey } from "./model-ref-shared.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

/** Options provided by agent runtime callers when invoking OpenClaw plugin tools. */
export type OpenClawPluginToolOptions = {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Current routable conversation target when no explicit agent target is available. */
  currentChannelId?: string;
  agentThreadId?: string | number;
  nativeChannelId?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  fsPolicy?: ToolFsPolicy;
  modelProvider?: string;
  modelId?: string;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAgentIdOverride?: string;
  sessionId?: string;
  /**
   * Explicit one-shot local CLI runs should not keep plugin-owned process
   * resources alive after emitting their result.
   */
  oneShotCliRun?: boolean;
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  sandboxed?: boolean;
  allowGatewaySubagentBinding?: boolean;
  toolBindings?: Readonly<Record<string, unknown>>;
};

/** Resolves plugin-tool context inputs from runtime options and config state. */
export function resolveOpenClawPluginToolInputs(params: {
  options?: OpenClawPluginToolOptions;
  resolvedConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig | undefined;
}) {
  const { options, resolvedConfig, runtimeConfig, getRuntimeConfig } = params;
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const modelProvider = options?.modelProvider?.trim();
  const modelId = options?.modelId?.trim();
  const activeModel =
    modelProvider || modelId
      ? {
          ...(modelProvider ? { provider: modelProvider } : {}),
          ...(modelId ? { modelId } : {}),
          ...(modelProvider && modelId ? { modelRef: modelKey(modelProvider, modelId) } : {}),
        }
      : undefined;
  // Delivery context is normalized once here so plugin tools receive the same
  // channel/account/thread shape as gateway-delivered agent tools.
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo ?? options?.currentMessagingTarget ?? options?.currentChannelId,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });

  return {
    context: {
      config: options?.config,
      runtimeConfig,
      getRuntimeConfig,
      fsPolicy: options?.fsPolicy,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: sessionAgentId,
      sessionKey: options?.agentSessionKey,
      sessionId: options?.sessionId,
      toolBindings: options?.toolBindings,
      activeModel,
      browser: {
        sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
        allowHostControl: options?.allowHostBrowserControl,
      },
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      deliveryContext,
      nativeChannelId: options?.nativeChannelId,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      senderIsOwner: options?.senderIsOwner,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        options?.conversationReadOrigin,
      ),
      sandboxed: options?.sandboxed,
      oneShotCliRun: options?.oneShotCliRun,
    },
    allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
  };
}
