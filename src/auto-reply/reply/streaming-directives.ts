import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { splitMediaFromOutput } from "../../media/parse.js";
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

// Holds back incomplete streaming-directive tails so parseChunk only ever sees
// complete directives. Otherwise, upstream token boundaries can split markers
// like `MEDIA:<path>` between chunks and cause the first half to be emitted as
// plain text (e.g. the `MEDIA` token leaking into a channel reply while the
// matching file path is silently dropped on the next chunk).
export const splitTrailingDirective = (
  text: string,
  options: SplitTrailingDirectiveOptions = {},
): { text: string; tail: string } => {
  let bufferStart = text.length;

  // 1. Unclosed `[[…` reply/audio directive tail.
  const openIndex = text.lastIndexOf("[[");
  if (openIndex >= 0 && !text.includes("]]", openIndex + 2)) {
    if (openIndex < bufferStart) {
      bufferStart = openIndex;
    }
  }
  if (text.endsWith("[") && text.length - 1 < bufferStart) {
    bufferStart = text.length - 1;
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

  // 2. `MEDIA:` line without a trailing newline — the URL may still be
  //    streaming. `splitMediaFromOutput` in src/media/parse.ts treats a
  //    line as a media directive only when `line.trimStart()` begins with
  //    `MEDIA:`, so we match the same shape here: only buffer when the
  //    last line looks like an actual directive line (optional leading
  //    whitespace, then `MEDIA:`). Prose such as
  //    "See the MEDIA: section for details" does NOT qualify and is
  //    flushed as ordinary text — otherwise it could sit in pendingTail
  //    and be silently dropped if a stream-item boundary calls `reset()`
  //    without a preceding `consume("", { final: true })`.
  const lastNewline = text.lastIndexOf("\n");
  const lastLine = lastNewline < 0 ? text : text.slice(lastNewline + 1);
  if (/^\s*MEDIA:/i.test(lastLine)) {
    const mediaLineStart = lastNewline < 0 ? 0 : lastNewline + 1;
    if (mediaLineStart < bufferStart) {
      bufferStart = mediaLineStart;
    }
  }

  // 3. Trailing `M|ME|MED|MEDI|MEDIA` prefix (no colon yet) at the start of
  //    a line — the next chunk might turn this into `MEDIA:<url>`. Only a
  //    line-start anchor (`^` or immediately after `\n`) is accepted so
  //    mid-prose tokens like "_M", "3ME", or "token MEDIA" are not
  //    speculatively buffered and cannot accidentally be glued to a
  //    following `:` into a synthetic directive. Matches the canonical
  //    MEDIA directive placement (own line after `\n\n`).
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
    text: text.slice(0, bufferStart),
    tail: text.slice(bufferStart),
  };
};

const parseChunk = (raw: string, options?: { silentToken?: string }): ParsedChunk => {
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
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
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    replyToId: replyParsed.replyToId,
    replyToExplicitId: replyParsed.replyToExplicitId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
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
