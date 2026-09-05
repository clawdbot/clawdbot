/** Parses inline reply directives such as media, reply targets, audio, and silence. */
import { trySafeFileURLToPath } from "../../infra/local-file-access.js";
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

  const replyParsed = text.includes("[[")
    ? parseInlineDirectives(text, {
        currentMessageId: options.currentMessageId,
        stripAudioTag: false,
      })
    : undefined;

  text = stripInlineDirectiveTagsForDelivery(
    replyParsed?.hasReplyTag ? replyParsed.text : text,
  ).text;

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);

  return {
    // Silent payloads must not leak the control token into channel delivery.
    text: isSilent ? "" : text,
    // Keep native path conversion outside the browser-shared parser and before reply policy.
    mediaUrls: split.mediaUrls?.map((source) => trySafeFileURLToPath(source) ?? source),
    replyToId: replyParsed?.replyToId,
    replyToCurrent: replyParsed?.replyToCurrent || undefined,
    replyToTag: replyParsed?.hasReplyTag ?? false,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
