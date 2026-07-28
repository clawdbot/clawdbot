import {
  createAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type AttemptTaskRuntimeScopeInput = Pick<
  RunEmbeddedAgentParams,
  | "sessionKey"
  | "messageChannel"
  | "messageProvider"
  | "agentAccountId"
  | "messageTo"
  | "messageThreadId"
  | "currentMessagingTarget"
  | "currentThreadTs"
  | "currentChannelId"
  | "chatId"
  | "currentMessageId"
>;

/** Captures requester routing and source-message provenance when an attempt is created. */
export function createAttemptTaskRuntimeScope(
  params: AttemptTaskRuntimeScopeInput,
): AgentHarnessTaskRuntimeScope | undefined {
  if (!params.sessionKey?.trim()) {
    return undefined;
  }
  const channel = firstNonBlank(params.messageChannel, params.messageProvider);
  const to = firstNonBlank(params.currentMessagingTarget, params.messageTo);
  const threadId = firstNonBlank(params.messageThreadId, params.currentThreadTs);
  return createAgentHarnessTaskRuntimeScope({
    requesterSessionKey: params.sessionKey,
    requesterOrigin: {
      channel,
      accountId: params.agentAccountId,
      to,
      threadId,
    },
    requesterPresentation: {
      channel,
      accountId: params.agentAccountId,
      to,
      threadId,
      channelId: firstNonBlank(params.currentChannelId, params.chatId),
      messageId: params.currentMessageId,
    },
  });
}

function firstNonBlank<T extends string | number>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        return value;
      }
      continue;
    }
    const normalized = value?.trim();
    if (normalized) {
      return normalized as T;
    }
  }
  return undefined;
}
