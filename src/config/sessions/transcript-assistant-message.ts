import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";

/** Strips final-answer directives in place so live state and persisted bytes stay identical. */
export function applyAssistantDeliveryDirectives(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") {
    return message;
  }
  let facts: NonNullable<typeof message.openclawDelivery> | undefined;
  for (const block of message.content) {
    if (block.type !== "text") {
      continue;
    }
    const parsed = parseInlineDirectives(block.text);
    if (!parsed.hasAudioTag && !parsed.hasReplyTag) {
      continue;
    }
    facts ??= {};
    block.text = parsed.text;
    Object.assign(facts, {
      ...(parsed.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(parsed.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(parsed.replyToExplicitId ? { replyToId: parsed.replyToExplicitId } : {}),
    });
  }
  if (facts) {
    message.openclawDelivery = facts;
  }
  return message;
}

export type AssistantBeforeMessageWrite = (params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

export function applyBeforeMessageWriteToAssistant(params: {
  message: Parameters<SessionManager["appendMessage"]>[0];
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  explicitIdempotencyKey?: string;
  agentId?: string;
  sessionKey: string;
}): Parameters<SessionManager["appendMessage"]>[0] | undefined {
  const nextMessage = params.beforeMessageWrite
    ? params.beforeMessageWrite({
        message: params.message as AgentMessage,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        sessionKey: params.sessionKey,
      })
    : params.message;
  if (nextMessage?.role !== "assistant") {
    return undefined;
  }
  return Object.assign(
    applyAssistantDeliveryDirectives(nextMessage),
    params.explicitIdempotencyKey ? { idempotencyKey: params.explicitIdempotencyKey } : {},
  ) as Parameters<SessionManager["appendMessage"]>[0];
}
