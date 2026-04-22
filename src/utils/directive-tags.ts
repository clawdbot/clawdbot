import { normalizeOptionalString } from "../shared/string-coerce.js";

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

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const INLINE_DIRECTIVE_TAG_WITH_PADDING_RE =
  /\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*/gi;
const MAX_REPLY_DIRECTIVE_ID_LENGTH = 256;

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

function normalizeDirectiveWhitespace(text: string): string {
  // Extract → normalize prose → restore:
  // Stash every code block (fenced ``` / ~~~ and indent-code 4-space/tab)
  // under a sentinel-delimited placeholder so the prose regexes never touch them.
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const masked = text.replace(
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?:    |\t)[^\n]*)+/gm,
    (block) => {
      blocks.push(block);
      return `${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    },
  );

  const normalized = masked
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return normalized.replace(blockPlaceholderRe, (_, i) => blocks[Number(i)]);
}

type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};

type MessageTextPart = {
  type: "text";
  text: string;
} & Record<string, unknown>;

type MessagePart = Record<string, unknown> | null | undefined;

export type DisplayMessageWithContent = {
  content?: unknown;
} & Record<string, unknown>;

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const withoutAudio = text.replace(AUDIO_TAG_RE, "");
  const stripped = withoutAudio.replace(REPLY_TAG_RE, "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}

function stripUnsafeReplyDirectiveChars(value: string): string {
  let next = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127 || ch === "[" || ch === "]") {
      continue;
    }
    next += ch;
  }
  return next;
}

export function sanitizeReplyDirectiveId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = stripUnsafeReplyDirectiveChars(trimmed).trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length > MAX_REPLY_DIRECTIVE_ID_LENGTH) {
    return sanitized.slice(0, MAX_REPLY_DIRECTIVE_ID_LENGTH);
  }
  return sanitized;
}

export function stripInlineDirectiveTagsForDelivery(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const stripped = text.replace(INLINE_DIRECTIVE_TAG_WITH_PADDING_RE, " ");
  const changed = stripped !== text;
  return {
    text: changed ? stripped.trim() : text,
    changed,
  };
}

function isMessageTextPart(part: MessagePart): part is MessageTextPart {
  return Boolean(part) && part?.type === "text" && typeof part.text === "string";
}

/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
export function stripInlineDirectiveTagsFromMessageForDisplay(
  message: DisplayMessageWithContent | undefined,
): DisplayMessageWithContent | undefined {
  if (!message) {
    return message;
  }
  if (!Array.isArray(message.content)) {
    return message;
  }
  const cleaned = message.content.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    const record = part as MessagePart;
    if (!isMessageTextPart(record)) {
      return part;
    }
    return { ...record, text: stripInlineDirectiveTagsForDisplay(record.text).text };
  });
  return { ...message, content: cleaned };
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
  if (!text) {
    return {
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }
  if (!text.includes("[[")) {
    return {
      text: normalizeDirectiveWhitespace(text),
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match, offset, source) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

  cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw: string | undefined, offset, source) => {
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? replacementPreservesWordBoundary(source, offset, match.length) : match;
  });

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
