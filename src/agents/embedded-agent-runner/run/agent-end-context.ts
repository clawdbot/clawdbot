import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import type { EmbeddedForegroundPromptContext } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AgentEndContext = Parameters<typeof runAgentEndSideEffects>[0]["ctx"] & {
  foregroundPromptContext: EmbeddedForegroundPromptContext;
};

type EmbeddedForegroundPromptContextRun = Pick<
  EmbeddedRunAttemptParams,
  Exclude<keyof EmbeddedForegroundPromptContext, "agentDir" | "agentId" | "cronCreatorCallerOrigin">
> &
  Pick<EmbeddedRunAttemptParams, "cronCreatorAuthorityCapability" | "sessionId" | "sessionKey"> & {
    agentId: string;
  };

export function buildEmbeddedForegroundPromptContext(
  run: EmbeddedForegroundPromptContextRun,
  agentDir: string,
): EmbeddedForegroundPromptContext {
  const callerOrigin = run.cronCreatorAuthorityCapability?.callerOrigin;
  const sessionKey = run.sessionKey?.trim() || run.sessionId;
  const sandboxSessionKey = run.sandboxSessionKey?.trim() || sessionKey;
  return {
    agentId: run.agentId,
    agentDir,
    workspaceDir: run.workspaceDir,
    cwd: run.cwd,
    sandboxSessionKey,
    // Detached runs replace the execution key; preserve only a known policy owner.
    sandboxAgentId:
      run.sandboxAgentId ?? (sandboxSessionKey === sessionKey ? run.agentId : undefined),
    promptCacheKey: run.promptCacheKey,
    reasoningLevel: run.reasoningLevel,
    messageChannel: run.messageChannel,
    messageProvider: run.messageProvider,
    clientCaps: run.clientCaps,
    toolBindings: run.toolBindings,
    chatType: run.chatType,
    agentAccountId: run.agentAccountId,
    trigger: run.trigger,
    messageTo: run.messageTo,
    messageThreadId: run.messageThreadId,
    conversationToolPolicy: run.conversationToolPolicy,
    groupId: run.groupId,
    groupChannel: run.groupChannel,
    groupSpace: run.groupSpace,
    memberRoleIds: run.memberRoleIds,
    messageActionTurnCapability: run.messageActionTurnCapability,
    spawnedBy: run.spawnedBy,
    isCanonicalWorkspace: run.isCanonicalWorkspace,
    senderId: run.senderId,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    senderIsOwner: run.senderIsOwner,
    approvalReviewerDeviceId: run.approvalReviewerDeviceId,
    currentChannelId: run.currentChannelId,
    chatId: run.chatId,
    channelContext: run.channelContext,
    currentMessagingTarget: run.currentMessagingTarget,
    currentThreadTs: run.currentThreadTs,
    currentMessageId: run.currentMessageId,
    currentInboundAudio: run.currentInboundAudio,
    replyToMode: run.replyToMode,
    requireExplicitMessageTarget: run.requireExplicitMessageTarget,
    disableMessageTool: run.disableMessageTool,
    githubPublicationAvailable: run.githubPublicationAvailable,
    conversationRecall: run.conversationRecall,
    toolOverrides: run.toolOverrides,
    skillsSnapshot: run.skillsSnapshot,
    currentInboundEventKind: run.currentInboundEventKind,
    clientTools: run.clientTools,
    disableTools: run.disableTools,
    contextWindow: run.contextWindow,
    promptMode: run.promptMode,
    forceMessageTool: run.forceMessageTool,
    enableHeartbeatTool: run.enableHeartbeatTool,
    forceHeartbeatTool: run.forceHeartbeatTool,
    allowGatewaySubagentBinding: run.allowGatewaySubagentBinding,
    extraSystemPrompt: run.extraSystemPrompt,
    sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: run.taskSuggestionDeliveryMode,
    silentReplyPromptMode: run.silentReplyPromptMode,
    ownerNumbers: run.ownerNumbers,
    toolsAllow: run.toolsAllow,
    runtimePluginToolGrant: run.runtimePluginToolGrant,
    inputProvenance: run.inputProvenance,
    scheduledToolPolicy: run.scheduledToolPolicy,
    modelThinkingCapability: run.modelThinkingCapability,
    modelFallbacksOverride: run.modelFallbacksOverride,
    ...(callerOrigin && callerOrigin.kind !== "unknown"
      ? { cronCreatorCallerOrigin: callerOrigin }
      : {}),
  };
}

export function buildEmbeddedAgentEndContext(params: {
  run: EmbeddedRunAttemptParams;
  agentId: string;
  agentDir: string;
  trace: AgentEndContext["trace"];
  skillWorkshopAvailable: boolean;
  compacted: boolean;
}): AgentEndContext {
  const run = params.run;
  return {
    runId: run.runId,
    trace: params.trace,
    agentId: params.agentId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    workspaceDir: run.workspaceDir,
    modelProviderId: run.provider,
    modelId: run.modelId,
    modelContextWindowTokens: run.contextTokenBudget ?? run.model.contextWindow,
    foregroundPromptContext: buildEmbeddedForegroundPromptContext(
      { ...run, agentId: params.agentId },
      params.agentDir,
    ),
    authProfileId: run.authProfileId,
    skillWorkshopAvailable: params.skillWorkshopAvailable,
    compacted: params.compacted,
    trigger: run.trigger,
    ...(run.config ? { config: run.config } : {}),
    ...buildAgentHookContextChannelFields(run),
    ...buildAgentHookContextIdentityFields({
      trigger: run.trigger,
      senderId: run.senderId,
      chatId: run.chatId,
      channelContext: run.channelContext,
    }),
  };
}
