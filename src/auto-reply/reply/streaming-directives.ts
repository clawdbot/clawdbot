import { expectDefined } from "@openclaw/normalization-core";
// Converts streaming reply directives into payload delivery decisions.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";
import { stripContinuationSignal } from "../continuation/signal.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyDirectiveParseResult } from "./reply-directives.js";

type PendingReplyState = {
  explicitId?: string;
  sawCurrent: boolean;
  hasTag: boolean;
};

type ParsedChunk = ReplyDirectiveParseResult & {
  replyToExplicitId?: string;
};

type ConsumeOptions = {
  final?: boolean;
  silentToken?: string;
};

const TRAILING_CONTINUATION_SIGNAL_PATTERNS = [
  /\[\[\s*CONTINUE_DELEGATE:\s*(?:(?!\]\])[\s\S])+?\s*\]\]\s*$/,
  /\[\[\s*CONTINUE_WORK(?::\d+)?\s*\]\]\s*$/,
  /\bCONTINUE_WORK(?::\d+)?\s*$/,
] as const;
const TRAILING_CONTINUATION_TOKEN_RE = /([A-Z_][A-Z_0-9:]*)(\s*)$/;
const CONTINUE_WORK_BARE_TOKEN = "CONTINUE_WORK";

function resolveTrailingContinuationSignalStart(text: string): number | undefined {
  for (const pattern of TRAILING_CONTINUATION_SIGNAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return text.length - match[0].length;
    }
  }
  return undefined;
}

function resolveTrailingContinuationPrefixStart(text: string): number | undefined {
  const match = text.match(TRAILING_CONTINUATION_TOKEN_RE);
  if (!match) {
    return undefined;
  }
  const token = expectDefined(match[1], "continuation token capture");
  if (!token.startsWith("CONT")) {
    return undefined;
  }
  if (!CONTINUE_WORK_BARE_TOKEN.startsWith(token) && !/^CONTINUE_WORK:\d*$/.test(token)) {
    return undefined;
  }
  return text.length - match[0].length;
}

// TRANSITIONAL(marker-retirement): streaming tail-buffering exists only because
// live drafts still carry inline markers mid-run. Delete alongside the marker
// parser when the visibleReplies default flips to "message_tool".
// Holds back incomplete inline directive tails so parseChunk only ever sees
// complete reply/audio tags.
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

  const continuationSignalStart = resolveTrailingContinuationSignalStart(text);
  if (continuationSignalStart !== undefined && continuationSignalStart < bufferStart) {
    bufferStart = continuationSignalStart;
  } else {
    const continuationPrefixStart = resolveTrailingContinuationPrefixStart(text);
    if (continuationPrefixStart !== undefined && continuationPrefixStart < bufferStart) {
      bufferStart = continuationPrefixStart;
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

const parseChunk = (raw: string, options?: { silentToken?: string }): ParsedChunk => {
  let text = raw ?? "";
  const replyParsed = parseInlineDirectives(text, {
    stripAudioTag: true,
    stripReplyTags: true,
  });
  if (replyParsed.hasReplyTag || replyParsed.hasAudioTag) {
    text = replyParsed.text;
  }

  const silentToken = options?.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent =
    isSilentReplyText(text, silentToken) || isSilentReplyPrefixText(text, silentToken);
  if (isSilent) {
    text = "";
  } else if (startsWithSilentToken(text, silentToken)) {
    text = stripLeadingSilentToken(text, silentToken);
  }
  if (text) {
    const continuation = stripContinuationSignal(text);
    if (continuation.signal) {
      text = continuation.text;
    }
  }

  return {
    text,
    replyToId: replyParsed.replyToId,
    replyToExplicitId: replyParsed.replyToExplicitId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: replyParsed.audioAsVoice,
    isSilent,
  };
};

const hasRenderableContent = (parsed: ReplyDirectiveParseResult): boolean =>
  hasOutboundReplyContent(parsed) || Boolean(parsed.audioAsVoice);

export function createStreamingDirectiveAccumulator() {
  let pendingTail = "";
  let pendingSeparator = "";
  let pendingReply: PendingReplyState = { sawCurrent: false, hasTag: false };
  let activeReply: PendingReplyState = { sawCurrent: false, hasTag: false };
  let hasReturnedText = false;

  const reset = () => {
    pendingTail = "";
    pendingSeparator = "";
    pendingReply = { sawCurrent: false, hasTag: false };
    activeReply = { sawCurrent: false, hasTag: false };
    hasReturnedText = false;
  };

  const consume = (raw: string, options: ConsumeOptions = {}): ReplyDirectiveParseResult | null => {
    const hadPendingTail = pendingTail.length > 0;
    const heldSeparator = pendingSeparator;
    let combined = `${pendingTail}${raw ?? ""}`;
    pendingTail = "";
    pendingSeparator = "";

    if (!options.final) {
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

    const parsed = parseChunk(combined, { silentToken: options.silentToken });
    if (hadPendingTail && heldSeparator && parsed.text.startsWith("[")) {
      parsed.text = `${heldSeparator}${parsed.text}`;
    }
    // Only a message-leading malformed marker is delivery control. Once text has
    // streamed, a later marker is literal content whose Markdown opener may be gone.
    if (options.final && !hasReturnedText) {
      parsed.text = stripInlineDirectiveTagsForDelivery(parsed.text).text;
    }
    const hasTag = activeReply.hasTag || pendingReply.hasTag || parsed.replyToTag;
    const sawCurrent =
      activeReply.sawCurrent || pendingReply.sawCurrent || parsed.replyToCurrent === true;
    const explicitId =
      parsed.replyToExplicitId ?? pendingReply.explicitId ?? activeReply.explicitId;

    const combinedResult: ReplyDirectiveParseResult = {
      ...parsed,
      replyToId: explicitId,
      replyToCurrent: sawCurrent,
      replyToTag: hasTag,
    };

    if (!hasRenderableContent(combinedResult)) {
      if (hasTag) {
        pendingReply = {
          explicitId,
          sawCurrent,
          hasTag,
        };
      }
      return null;
    }

    // Keep reply context sticky for the full assistant message so split/newline chunks
    // stay on the same native reply target until reset() is called for the next message.
    activeReply = {
      explicitId,
      sawCurrent,
      hasTag,
    };
    pendingReply = { sawCurrent: false, hasTag: false };
    hasReturnedText ||= Boolean(combinedResult.text);
    return combinedResult;
  };

  return {
    consume,
    reset,
  };
}
