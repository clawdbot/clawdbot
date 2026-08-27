/** Parses inline reply directives such as media, reply targets, audio, and silence. */
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";

/** Parsed outbound reply directives and media extracted from model text. */
export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
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

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  text = stripInlineDirectiveTagsForDelivery(
    replyParsed.hasReplyTag ? replyParsed.text : text,
  ).text;

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    // Silent payloads must not leak the control token into channel delivery.
    text = "";
  }

  return {
    text,
    mediaUrls: split.mediaUrls,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
