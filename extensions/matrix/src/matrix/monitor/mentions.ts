import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { RoomMessageEventContent } from "./types.js";

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const MAX_UNICODE_SCALAR_VALUE = 0x10ffff;

function decodeNumericHtmlEntity(match: string, rawValue: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(rawValue, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_UNICODE_SCALAR_VALUE ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    const normalized = normalizeLowercaseStringOrEmpty(entity);
    if (normalized.startsWith("#x")) {
      return decodeNumericHtmlEntity(match, normalized.slice(2), 16);
    }
    if (normalized.startsWith("#")) {
      return decodeNumericHtmlEntity(match, normalized.slice(1), 10);
    }
    return HTML_ENTITY_REPLACEMENTS[normalized] ?? match;
  });
}

function normalizeVisibleMentionText(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    decodeHtmlEntities(
      value.replace(/<[^>]+>/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
    ).replace(/\s+/g, " "),
  );
}

function extractVisibleMentionText(value?: string): string {
  return normalizeVisibleMentionText(value ?? "");
}

function resolveMatrixUserLocalpart(userId: string): string | null {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 1) {
    return null;
  }
  return trimmed.slice(1, colonIndex).trim() || null;
}

function isVisibleMentionLabel(params: {
  text: string;
  userId: string;
  mentionRegexes: RegExp[];
  displayName?: string | null;
}): boolean {
  const cleaned = extractVisibleMentionText(params.text);
  if (!cleaned) {
    return false;
  }
  if (params.mentionRegexes.some((pattern) => pattern.test(cleaned))) {
    return true;
  }
  const localpart = resolveMatrixUserLocalpart(params.userId);
  const candidates = [
    extractVisibleMentionText(params.userId),
    localpart ? extractVisibleMentionText(localpart) : null,
    localpart ? extractVisibleMentionText(`@${localpart}`) : null,
    params.displayName ? extractVisibleMentionText(params.displayName) : null,
    params.displayName ? extractVisibleMentionText(`@${params.displayName}`) : null,
  ].filter((value): value is string => Boolean(value));
  return candidates.includes(cleaned);
}

function hasVisibleRoomMention(value?: string): boolean {
  const cleaned = extractVisibleMentionText(value);
  return /(^|[^a-z0-9_])@room\b/i.test(cleaned);
}

/**
 * Check if formatted_body contains a matrix.to link whose visible label still
 * looks like a real mention for the given user. Do not trust href alone, since
 * senders can hide arbitrary matrix.to links behind unrelated link text.
 * Many Matrix clients (including Element) use HTML links in formatted_body instead of
 * or in addition to the m.mentions field.
 */
function checkFormattedBodyMention(params: {
  formattedBody?: string;
  userId: string;
  displayName?: string | null;
  mentionRegexes: RegExp[];
}): boolean {
  if (!params.formattedBody || !params.userId) {
    return false;
  }
  const anchorPattern = /<a\b[^>]*href=(["'])(https:\/\/matrix\.to\/#[^"']+)\1[^>]*>(.*?)<\/a>/gis;
  for (const match of params.formattedBody.matchAll(anchorPattern)) {
    const href = match[2];
    const visibleLabel = match[3] ?? "";
    if (!href) {
      continue;
    }
    try {
      const parsed = new URL(href);
      const fragmentTarget = decodeURIComponent(parsed.hash.replace(/^#\/?/, "").trim());
      if (fragmentTarget !== params.userId.trim()) {
        continue;
      }
      if (
        isVisibleMentionLabel({
          text: visibleLabel,
          userId: params.userId,
          mentionRegexes: params.mentionRegexes,
          displayName: params.displayName,
        })
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function resolveMentions(params: {
  content: RoomMessageEventContent;
  userId?: string | null;
  displayName?: string | null;
  text?: string;
  mentionRegexes: RegExp[];
}) {
  const mentions = params.content["m.mentions"];
  const mentionedUsers = Array.isArray(mentions?.user_ids)
    ? new Set(mentions.user_ids)
    : new Set<string>();
  const textMentioned = getMatrixRuntime().channel.mentions.matchesMentionPatterns(
    params.text ?? "",
    params.mentionRegexes,
  );
  const visibleRoomMention =
    hasVisibleRoomMention(params.text) || hasVisibleRoomMention(params.content.formatted_body);

  // Check formatted_body for matrix.to mention links (legacy/alternative mention format)
  const mentionedInFormattedBody = params.userId
    ? checkFormattedBodyMention({
        formattedBody: params.content.formatted_body,
        userId: params.userId,
        displayName: params.displayName,
        mentionRegexes: params.mentionRegexes,
      })
    : false;
  // Matrix clients can mention users through m.mentions metadata plus a visible
  // Matrix URI label in formatted_body. Keep the visible-mention requirement so
  // hidden metadata-only mentions do not trigger the handler.
  const metadataBackedUserMention = Boolean(
    params.userId &&
    mentionedUsers.has(params.userId) &&
    (mentionedInFormattedBody || textMentioned),
  );
  const metadataBackedRoomMention = Boolean(mentions?.room) && visibleRoomMention;
  const explicitMention =
    mentionedInFormattedBody || metadataBackedUserMention || metadataBackedRoomMention;

  const wasMentioned = explicitMention || textMentioned || visibleRoomMention;
  return { wasMentioned, hasExplicitMention: explicitMention };
}
