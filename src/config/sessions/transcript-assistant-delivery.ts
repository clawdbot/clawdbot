import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts } from "../../llm/types.js";
import { extractTtsDirectiveFacts } from "../../tts/directive-facts.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

type AssistantDeliveryFacts = {
  audioAsVoice?: true;
  replyToCurrent?: true;
  replyToId?: string;
  tts?: AssistantDeliveryTtsFacts;
};

function mergeTtsFacts(
  current: AssistantDeliveryTtsFacts | undefined,
  next: AssistantDeliveryTtsFacts,
): AssistantDeliveryTtsFacts {
  return {
    tagged: true,
    ...((current?.text ?? next.text) != null ? { text: current?.text ?? next.text } : {}),
    ...(current?.directives || next.directives
      ? { directives: [...(current?.directives ?? []), ...(next.directives ?? [])] }
      : {}),
  };
}

/** Strips final-answer directives in place so live state and persisted bytes stay identical. */
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  let facts: AssistantDeliveryFacts | undefined;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const parsed = parseInlineDirectives(block.text);
    const tts = extractTtsDirectiveFacts(parsed.text);
    if (!parsed.hasAudioTag && !parsed.hasReplyTag && !tts.facts) {
      continue;
    }
    facts ??= {};
    block.text = tts.facts ? tts.cleanedText.trim() : tts.cleanedText;
    Object.assign(facts, {
      ...(parsed.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(parsed.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(parsed.replyToExplicitId ? { replyToId: parsed.replyToExplicitId } : {}),
      ...(tts.facts ? { tts: mergeTtsFacts(facts.tts, tts.facts) } : {}),
    });
  }
  if (facts) {
    Object.assign(message, { openclawDelivery: facts });
  }
  return message;
}
