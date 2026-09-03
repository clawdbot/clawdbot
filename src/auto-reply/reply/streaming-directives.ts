// Converts streaming reply directives into payload delivery decisions.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyDirectiveParseResult } from "./reply-directives.js";

type ConsumeOptions = {
  final?: boolean;
  silentToken?: string;
};

// TRANSITIONAL(marker-retirement): streaming tail-buffering exists only because
// live drafts still carry inline markers mid-run. Delete alongside the marker
// parser when the visibleReplies default flips to "message_tool".
// Hold incomplete tails until the inline parser can read complete reply/audio tags.
export const splitTrailingDirective = (text: string): { text: string; tail: string } => {
  let bufferStart = text.length;
  let trimTextBeforeTail = false;

  // 1. Unclosed `[[…` reply/audio directive tail.
  const openIndex = text.lastIndexOf("[[");
  if (openIndex >= 0 && !text.includes("]]", openIndex + 2)) {
    if (openIndex < bufferStart) {
      bufferStart = openIndex;
      trimTextBeforeTail = true;
    }
  }
  if (text.endsWith("[") && text.length - 1 < bufferStart) {
    bufferStart = text.length - 1;
    trimTextBeforeTail = true;
  }

  // Keep a possible final-reply MEDIA directive out of partial streaming
  // payloads. The final message parser still owns legacy MEDIA delivery.
  const lastNewline = text.lastIndexOf("\n");
  const lastLine = lastNewline < 0 ? text : text.slice(lastNewline + 1);
  if (/^\s*MEDIA:/i.test(lastLine)) {
    const mediaLineStart = lastNewline < 0 ? 0 : lastNewline + 1;
    if (mediaLineStart < bufferStart) {
      bufferStart = mediaLineStart;
    }
  }

  const prefixMatch = lastLine.match(/^[\t ]*(MEDIA|MEDI|MED|ME|M)$/i);
  if (prefixMatch) {
    const mediaLineStart = lastNewline < 0 ? 0 : lastNewline + 1;
    if (mediaLineStart < bufferStart) {
      bufferStart = mediaLineStart;
    }
  }

  if (bufferStart >= text.length) {
    return { text, tail: "" };
  }

  return {
    text: trimTextBeforeTail ? text.slice(0, bufferStart).trimEnd() : text.slice(0, bufferStart),
    tail: text.slice(bufferStart),
  };
};

export function createStreamingDirectiveAccumulator() {
  let pendingTail = "";
  let pendingSeparator = "";
  let replyToId: string | undefined;
  let replyToCurrent = false;
  let replyToTag = false;
  let hasReturnedText = false;

  const reset = () => {
    pendingTail = "";
    pendingSeparator = "";
    replyToId = undefined;
    replyToCurrent = false;
    replyToTag = false;
    hasReturnedText = false;
  };

  const consume = (raw: string, options?: ConsumeOptions): ReplyDirectiveParseResult | null => {
    const hadPendingTail = pendingTail.length > 0;
    const heldSeparator = pendingSeparator;
    let combined = `${pendingTail}${raw ?? ""}`;
    pendingTail = "";
    pendingSeparator = "";

    if (!options?.final) {
      const split = splitTrailingDirective(combined);
      if (split.tail) {
        const tailStart = combined.length - split.tail.length;
        const separator = combined.slice(split.text.length, tailStart);
        // The separator is not part of a possible directive. Hold it separately
        // so valid completions keep existing streaming behavior while a final
        // malformed tail can be restored verbatim.
        pendingSeparator = split.text ? separator : `${heldSeparator}${separator}`;
      }
      combined = split.text;
      pendingTail = split.tail;
    }

    if (!combined) {
      return null;
    }

    const parsed = combined.includes("[[") ? parseInlineDirectives(combined) : undefined;
    let text = parsed && (parsed.hasReplyTag || parsed.hasAudioTag) ? parsed.text : combined;
    const silentToken = options?.silentToken ?? SILENT_REPLY_TOKEN;
    const isSilent =
      isSilentReplyText(text, silentToken) || isSilentReplyPrefixText(text, silentToken);
    if (isSilent) {
      text = "";
    } else if (startsWithSilentToken(text, silentToken)) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    if (hadPendingTail && heldSeparator && text.startsWith("[")) {
      text = heldSeparator + text;
    }
    // Only a message-leading malformed marker is delivery control. Once text has
    // streamed, a later marker is literal content whose Markdown opener may be gone.
    if (options?.final && !hasReturnedText) {
      text = stripInlineDirectiveTagsForDelivery(text).text;
    }
    // Reply context survives directive-only and visible chunks until the assistant message resets.
    replyToId = parsed?.replyToExplicitId ?? replyToId;
    replyToCurrent ||= parsed?.replyToCurrent === true;
    replyToTag ||= parsed?.hasReplyTag === true;

    const combinedResult = {
      text,
      replyToId,
      replyToExplicitId: parsed?.replyToExplicitId,
      replyToCurrent,
      replyToTag,
      audioAsVoice: parsed?.audioAsVoice ?? false,
      isSilent,
    };

    if (!hasOutboundReplyContent(combinedResult) && !combinedResult.audioAsVoice) {
      return null;
    }

    hasReturnedText ||= Boolean(combinedResult.text);
    return combinedResult;
  };

  return {
    consume,
    reset,
  };
}
