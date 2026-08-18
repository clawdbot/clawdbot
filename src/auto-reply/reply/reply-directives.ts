/** Parses inline reply directives such as media, reply targets, audio, and silence. */
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
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
  /**
   * True when at least one `MEDIA:` token was skipped because it sits inside a
   * fenced code block (see #41966). This is a pure signal — the warning is
   * emitted once at the outbound delivery boundary, never here, because
   * `parseReplyDirectives` runs on comparison/planning paths that may parse the
   * same payload multiple times.
   */
  mediaTokenSkippedInFence: boolean;
  /**
   * Exact fenced `MEDIA:` directive lines skipped during parse (trimmed).
   * Transient identity for accepted-delivery matching after hooks (#41966).
   */
  fencedSkippedMediaDirectives: string[];
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
  let mediaTokenSkippedInFence = false;
  const fencedSkippedMediaDirectives: string[] = [];
  const split = splitMediaFromOutput(raw, {
    extractMarkdownImages: options.extractMarkdownImages,
    extractMediaDirectives: options.extractMediaDirectives,
    onFencedMediaTokenSkipped: (line) => {
      mediaTokenSkippedInFence = true;
      const identity = line.trim();
      if (identity && !fencedSkippedMediaDirectives.includes(identity)) {
        fencedSkippedMediaDirectives.push(identity);
      }
    },
  });
  let text = split.text ?? "";

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
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
    mediaTokenSkippedInFence,
    fencedSkippedMediaDirectives,
  };
}
