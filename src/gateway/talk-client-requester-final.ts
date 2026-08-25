import { registerRequesterFinalAttachment } from "../agents/subagents/requester-final-attachment.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";

export type TalkRequesterFinalBinding = {
  append: (text: string) => boolean;
};

export type TalkAgentConsultRequest = {
  prompt: string;
  signal?: AbortSignal;
  requesterFinal?: TalkRequesterFinalBinding;
};

export type TalkRequesterFinalRegistration = {
  releaseProvisional: () => void;
  revoke: () => void;
};

export type TalkPromptOwner = {
  claimCompletion?: () => boolean;
  cleanup?: () => void;
  identity?: { runId: string; sessionId: string };
  isCurrent?: () => boolean;
  requesterFinal?: TalkRequesterFinalBinding;
  requesterFinalRegistration?: TalkRequesterFinalRegistration;
  resolveRunStarted: () => void;
  runStarted: Promise<void>;
};

export type TalkAgentConsultRunner = {
  (request: TalkAgentConsultRequest): Promise<{ text: string; yielded?: true }>;
  claimAppend: () => boolean;
  steer: RealtimeVoiceAgentConsultRunner;
  revokeRequesterFinal: () => void;
};

export function registerTalkRequesterFinal(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  timeoutMs: number;
  binding: TalkRequesterFinalBinding;
}): TalkRequesterFinalRegistration {
  return registerRequesterFinalAttachment({
    requesterAgentId: params.agentId,
    requesterSessionKey: params.sessionKey,
    requesterSessionId: params.sessionId,
    requesterTurnRunId: params.runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    timeoutMs: params.timeoutMs,
    append: params.binding.append,
  });
}
