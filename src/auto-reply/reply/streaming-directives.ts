import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
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

const splitTrailingDirective = (text: string): { text: string; tail: string } => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex < 0) return { text, tail: "" };
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex >= 0) return { text, tail: "" };
  return {
    text: text.slice(0, openIndex),
    tail: text.slice(openIndex),
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
  const isSilent = isSilentReplyText(text, silentToken);
  if (isSilent) {
    text = "";
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
  Boolean(parsed.text) ||
  Boolean(parsed.mediaUrl) ||
  (parsed.mediaUrls?.length ?? 0) > 0 ||
  Boolean(parsed.audioAsVoice);

export function createStreamingDirectiveAccumulator() {
  let pendingTail = "";
  let pendingReply: PendingReplyState = { sawCurrent: false, hasTag: false };

  const reset = () => {
    pendingTail = "";
    pendingReply = { sawCurrent: false, hasTag: false };
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
    const hasTag = pendingReply.hasTag || parsed.replyToTag;
    const sawCurrent = pendingReply.sawCurrent || parsed.replyToCurrent;
    const explicitId = parsed.replyToExplicitId ?? pendingReply.explicitId;

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

    pendingReply = { sawCurrent: false, hasTag: false };
    return combinedResult;
  };

  return {
    consume,
    reset,
  };
}
