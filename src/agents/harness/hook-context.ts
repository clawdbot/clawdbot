import type { PluginHookAgentContext } from "../../plugins/hook-types.js";

export type AgentHarnessHookContext = {
  runId: string;
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
};

export function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
    runId: params.runId,
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
  };
}
