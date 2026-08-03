/**
 * Builds plugin hook context metadata for native agent harness events.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { buildAgentHookContextIdentityFields } from "../../plugins/hook-agent-context.js";
import type {
  PluginHookAgentContext,
  PluginHookChannelContext,
  PluginHookContextWindowSource,
} from "../../plugins/hook-types.js";

/**
 * Input facts used to build the agent portion of plugin hook events.
 *
 * Only stable run/session/model facts are forwarded to plugin hooks; config remains a local
 * construction input so hooks do not accidentally depend on mutable raw configuration.
 */
export type AgentHarnessHookContext = {
  runId?: string;
  trace?: DiagnosticTraceContext;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
  config?: OpenClawConfig;
  senderId?: string;
  chatId?: string;
  channel?: string;
  channelContext?: PluginHookChannelContext;
};

/** Builds the sparse hook context object passed to agent harness plugin hooks. */
export function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.trace ? { trace: params.trace } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.contextTokenBudget ? { contextTokenBudget: params.contextTokenBudget } : {}),
    ...(params.contextWindowSource ? { contextWindowSource: params.contextWindowSource } : {}),
    ...(params.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowReferenceTokens }
      : {}),
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId,
      chatId: params.chatId,
      channelContext: params.channelContext,
    }),
  };
}
