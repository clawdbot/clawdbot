import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
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

type SplitTrailingDirectiveOptions = {
  final?: boolean;
};

// Holds back incomplete inline directive tails so parseChunk only ever sees
// complete reply/audio tags.
export const splitTrailingDirective = (
  text: string,
  options: SplitTrailingDirectiveOptions = {},
): { text: string; tail: string } => {
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

  if (options.final) {
    if (bufferStart >= text.length) {
      return { text, tail: "" };
    }

    return {
      text: text.slice(0, bufferStart),
      tail: text.slice(bufferStart),
    };
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

  const prefixMatch = text.match(/(?:^|\n)(MEDIA|MEDI|MED|ME|M)$/i);
  if (prefixMatch) {
    const prefixStart = text.length - prefixMatch[1].length;
    if (prefixStart < bufferStart) {
      bufferStart = prefixStart;
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
  let pendingReply: PendingReplyState = { sawCurrent: false, hasTag: false };
  let activeReply: PendingReplyState = { sawCurrent: false, hasTag: false };

  const reset = () => {
    pendingTail = "";
    pendingReply = { sawCurrent: false, hasTag: false };
    activeReply = { sawCurrent: false, hasTag: false };
  };

  const consume = (raw: string, options: ConsumeOptions = {}): ReplyDirectiveParseResult | null => {
    let combined = `${pendingTail}${raw ?? ""}`;
    pendingTail = "";

    if (!options.final) {
      const split = splitTrailingDirective(combined);
      combined = split.text;
      pendingTail = split.tail;
    }

    if (!combined) {
      return null;
    }

    const parsed = parseChunk(combined, { silentToken: options.silentToken });
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
    return combinedResult;
  };

  return {
    consume,
    reset,
  };
}
