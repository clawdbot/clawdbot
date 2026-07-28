/** Parses inline reply directives such as media, reply targets, audio, and silence. */
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";

/** Parsed outbound reply directives and media extracted from model text. */
export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  reaction?: {
    emoji: string;
    replyToCurrent?: boolean;
    replyToId?: string;
  };
  replyToId?: string;
  replyToCurrent?: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
};

/** Options for extracting reply directives from model text. */
type ReplyDirectiveParseOptions = {
  currentMessageId?: string;
  silentToken?: string;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
};

const REACTION_DIRECTIVE_RE = /\[\[\s*(react|react_to_current)\s*:\s*([^\]\n]+?)\s*\]\]/giu;

function parseReactionDirective(text: string, currentMessageId?: string) {
  let reaction:
    | {
        emoji: string;
        replyToCurrent?: boolean;
        replyToId?: string;
      }
    | undefined;
  const cleaned = text.replace(REACTION_DIRECTIVE_RE, (_match, kind: string, rawEmoji: string) => {
    const emoji = rawEmoji.trim();
    if (emoji && !reaction) {
      const replyToCurrent = kind.toLowerCase() === "react_to_current";
      reaction = {
        emoji,
        ...(replyToCurrent ? { replyToCurrent: true } : {}),
        ...(replyToCurrent && currentMessageId ? { replyToId: currentMessageId } : {}),
      };
    }
    return "";
  });
  return { text: reaction ? cleaned.trimStart() : cleaned, reaction };
}

export function mergeReactionDirectiveChannelData(
  channelData: Record<string, unknown> | undefined,
  reaction: ReplyDirectiveParseResult["reaction"] | undefined,
): Record<string, unknown> | undefined {
  if (!reaction) {
    return channelData;
  }
  const telegramData =
    channelData?.telegram &&
    typeof channelData.telegram === "object" &&
    !Array.isArray(channelData.telegram)
      ? (channelData.telegram as Record<string, unknown>)
      : {};
  if ("reaction" in telegramData) {
    return channelData;
  }
  return {
    ...channelData,
    telegram: { ...telegramData, reaction },
  };
}

/** Parses media, reply-target, audio, and silent directives from reply text. */
export function parseReplyDirectives(
  raw: string,
  options: ReplyDirectiveParseOptions = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw, {
    extractMarkdownImages: options.extractMarkdownImages,
    extractMediaDirectives: options.extractMediaDirectives,
  });
  let text = split.text ?? "";

  const reactionParsed = parseReactionDirective(text, options.currentMessageId);
  text = reactionParsed.text;

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    // Silent payloads must not leak the control token into channel delivery.
    text = "";
  }

  return {
    text,
    mediaUrls: split.mediaUrls,
    reaction: reactionParsed.reaction,
    replyToId: replyParsed.replyToId ?? reactionParsed.reaction?.replyToId,
    replyToCurrent:
      replyParsed.replyToCurrent || reactionParsed.reaction?.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
