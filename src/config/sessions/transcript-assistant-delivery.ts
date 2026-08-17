import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseInlineDirectives } from "../../utils/directive-tags.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

/** Strips final-answer directives in place so live state and persisted bytes stay identical. */
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  let facts: { audioAsVoice?: true; replyToCurrent?: true; replyToId?: string } | undefined;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
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
    Object.assign(message, { openclawDelivery: facts });
  }
  return message;
}
