import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts } from "../../llm/types.js";
import { extractTtsDirectiveFacts } from "../../tts/directive-facts.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

type AssistantDeliveryFacts = {
  audioAsVoice?: true;
  mediaUrls?: string[];
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
// TRANSITIONAL(marker-retirement): once the visibleReplies default flips and the
// model stops emitting inline markers, this projection parses nothing and the
// whole applier (plus its parser imports) can be deleted; openclawDelivery facts
// then come exclusively from structured message-tool sends and managed-media rewrites.
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
  options?: { managedMediaUrls?: readonly string[] },
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  let facts: AssistantDeliveryFacts | undefined;
  const managedMediaUrls = Array.from(
    new Set(options?.managedMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const parsed = parseInlineDirectives(block.text);
    const stripped = stripInlineDirectiveTagsForDelivery(parsed.text);
    const tts = extractTtsDirectiveFacts(stripped.text);
    const hasDeliveryFacts = parsed.hasAudioTag || parsed.hasReplyTag || Boolean(tts.facts);
    if (!stripped.changed && !hasDeliveryFacts) {
      continue;
    }
    block.text = tts.facts ? tts.cleanedText.trim() : tts.cleanedText;
    if (!hasDeliveryFacts) {
      continue;
    }
    facts ??= {};
    Object.assign(facts, {
      ...(parsed.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(parsed.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(parsed.replyToExplicitId ? { replyToId: parsed.replyToExplicitId } : {}),
      ...(tts.facts ? { tts: mergeTtsFacts(facts.tts, tts.facts) } : {}),
    });
  }
  if (managedMediaUrls.length > 0) {
    facts = { ...facts, mediaUrls: managedMediaUrls };
  }
  if (facts) {
    const currentFacts = isRecord(message.openclawDelivery) ? message.openclawDelivery : undefined;
    const mergedFacts = { ...currentFacts, ...facts };
    if (facts.replyToId) {
      delete mergedFacts.replyToCurrent;
    } else if (facts.replyToCurrent) {
      delete mergedFacts.replyToId;
    }
    Object.assign(message, { openclawDelivery: mergedFacts });
  }
  return message;
}
