import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AgentEndContext = Parameters<typeof runAgentEndSideEffects>[0]["ctx"];

export function buildEmbeddedAgentEndContext(params: {
  run: EmbeddedRunAttemptParams;
  agentId: string;
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
    authProfileId: run.authProfileId,
    skillWorkshopAvailable: params.skillWorkshopAvailable,
    compacted: params.compacted,
    messageChannel: run.messageChannel,
    chatType: run.chatType,
    agentAccountId: run.agentAccountId,
    groupId: run.groupId,
    groupChannel: run.groupChannel,
    groupSpace: run.groupSpace,
    memberRoleIds: run.memberRoleIds,
    spawnedBy: run.spawnedBy,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    senderIsOwner: run.senderIsOwner,
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
