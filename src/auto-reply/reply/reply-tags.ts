// Parses inline reply tags that affect delivery, routing, and model behavior.
import { parseInlineDirectives } from "../../utils/directive-tags.js";

/** Extracts inline reply-target tags from outbound reply text. */
export function extractReplyToTag(
  text?: string,
  currentMessageId?: string,
): {
  cleaned: string;
  replyToId?: string;
  replyToCurrent: boolean;
  hasTag: boolean;
} {
  const result = parseInlineDirectives(text, {
    currentMessageId,
    stripAudioTag: false,
  });
  return {
    cleaned: result.text,
    replyToId: result.replyToId,
    replyToCurrent: result.replyToCurrent,
    hasTag: result.hasReplyTag,
  };
}
