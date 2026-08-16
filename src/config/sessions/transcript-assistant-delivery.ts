import type { AgentMessage } from "../../agents/runtime/index.js";
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
