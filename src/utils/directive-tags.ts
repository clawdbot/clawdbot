import { expectDefined } from "@openclaw/normalization-core";
// Directive tag helpers parse inline directive tags from user text.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";

export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
};

// TRANSITIONAL(marker-retirement): inline reply/audio markers are the last text
// adapter for automatic-mode replies. Delete this parser family when the
// messages.visibleReplies default flips to "message_tool" (structured fields own
// delivery intent; persisted transcripts already carry openclawDelivery facts).
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const INLINE_DIRECTIVE_TAG_WITH_PADDING_RE =
  /(?:\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*|^[\t ]*\[\[\s*(?:reply_to_current(?:[\t ]*\](?!\])|(?=[\t ]+\S)|[\t ]*$)|reply_to\s*:\s*(?:[^\]\r\n]*\](?!\])|[\t ]*$))[\t ]*)/giu;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;
const UNSAFE_REPLY_DIRECTIVE_CHARS_RE = /[\p{Cc}[\]]/gu;
const NO_INLINE_DIRECTIVES = {
  audioAsVoice: false,
  replyToCurrent: false,
  hasAudioTag: false,
  hasReplyTag: false,
} as const;

function replacementPreservesWordBoundary(source: string, offset: number, length: number): string {
  const before = source[offset - 1];
  const after = source[offset + length];
  return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? " " : "";
}

const BLOCK_SENTINEL_SEED = "\uE000";

function createBlockSentinel(text: string): string {
  let sentinel = BLOCK_SENTINEL_SEED;
  while (text.includes(sentinel)) {
    sentinel += BLOCK_SENTINEL_SEED;
  }
  return sentinel;
}

export function replaceOutsideCodeRegions(
  text: string,
  regex: RegExp,
  replacement: (match: string, captures: unknown[], offset: number, source: string) => string,
): string {
  const codeRegions = text.includes("[[") ? findCodeRegions(text) : [];
  return text.replace(regex, (...args: unknown[]) => {
    const match = String(args[0]);
    const offset = args.at(-2);
    return typeof offset === "number" && isInsideCode(offset + match.indexOf("[["), codeRegions)
      ? match
      : replacement(match, args.slice(1, -2), Number(offset), text);
  });
}

function normalizeDirectiveWhitespace(text: string): string {
  // Extract → normalize prose → restore:
  // Stash every code block (fenced ``` / ~~~ and indent-code 4-space/tab)
  // under a sentinel-delimited placeholder so the prose regexes never touch them.
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const codeRegions = text.includes("`") || text.includes("~~~") ? findCodeRegions(text) : [];
  let masked = "";
  let cursor = 0;
  // The canonical scanner keeps false closers, indented closers, and open fences intact.
  for (const span of codeRegions) {
    blocks.push(text.slice(span.start, span.end));
    masked += `${text.slice(cursor, span.start)}${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    cursor = span.end;
  }
  masked = `${masked}${text.slice(cursor)}`.replace(/(?:(?:^|\n)(?:    |\t)[^\n]*)+/gm, (block) => {
    blocks.push(block);
    return `${blockSentinel}${blocks.length - 1}${blockSentinel}`;
  });

  const normalized = masked
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return normalized.replace(blockPlaceholderRe, (_, i) =>
    expectDefined(blocks[Number(i)], "blocks entry at number(i)"),
  );
}

type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const withoutAudio = replaceOutsideCodeRegions(text, AUDIO_TAG_RE, () => "");
  const stripped = replaceOutsideCodeRegions(withoutAudio, REPLY_TAG_RE, () => "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

export function sanitizeReplyDirectiveId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.replace(UNSAFE_REPLY_DIRECTIVE_CHARS_RE, "").trim();
  if (!sanitized) {
    return undefined;
  }
  // UTF-16 length is an upper bound on the number of code points.
  return sanitized.length <= MAX_REPLY_DIRECTIVE_ID_LENGTH
    ? sanitized
    : Array.from(sanitized).slice(0, MAX_REPLY_DIRECTIVE_ID_LENGTH).join("");
}

export function stripInlineDirectiveTagsForDelivery(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  // Only malformed prefixes at the absolute message start are control text; keep
  // the regex non-multiline while code-region scanning preserves literal examples.
  const stripped = replaceOutsideCodeRegions(text, INLINE_DIRECTIVE_TAG_WITH_PADDING_RE, (match) =>
    match.includes("]]") ? " " : "",
  );
  const changed = stripped !== text;
  return {
    text: changed ? stripped.trim() : text,
    changed,
  };
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
  if (!text) {
    return { text: "", ...NO_INLINE_DIRECTIVES };
  }
  if (!text.includes("[[")) {
    return { text: normalizeDirectiveWhitespace(text), ...NO_INLINE_DIRECTIVES };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = replaceOutsideCodeRegions(cleaned, AUDIO_TAG_RE, (match, _captures, offset, source) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  cleaned = replaceOutsideCodeRegions(cleaned, REPLY_TAG_RE, (match, captures, offset, source) => {
    const idRaw = typeof captures[0] === "string" ? captures[0] : undefined;
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = sanitizeReplyDirectiveId(idRaw);
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  if (!hasAudioTag && !hasReplyTag) {
    return { text, ...NO_INLINE_DIRECTIVES };
  }

  cleaned = normalizeDirectiveWhitespace(cleaned);

  const replyToId =
    lastExplicitId ?? (sawCurrent ? normalizeOptionalString(currentMessageId) : undefined);

  return {
    text: cleaned,
    audioAsVoice,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}
