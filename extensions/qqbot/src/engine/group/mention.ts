// Qqbot plugin module implements mention behavior.
import {
  compileSafeRegexDetailed,
  type SafeRegexRejectReason,
} from "openclaw/plugin-sdk/security-runtime";
import { debugWarn } from "../utils/log.js";
export interface RawMention {
  is_you?: boolean;
  bot?: boolean;
  member_openid?: string;
  id?: string;
  user_openid?: string;
  nickname?: string;
  username?: string;
  scope?: "all" | "single";
}

interface DetectWasMentionedInput {
  eventType?: string;
  mentions?: RawMention[];
  content?: string;
  mentionPatterns?: string[];
}

interface HasAnyMentionInput {
  mentions?: RawMention[];
  content?: string;
}

const MENTION_TAG_RE = /<@!?\w+>/;
const MENTION_PATTERN_FLAGS = "i";
const MAX_MENTION_PATTERN_CACHE_KEYS = 256;
const MAX_MENTION_PATTERN_WARNING_KEYS = 256;
const mentionPatternCompileCache = new Map<string, RegExp[]>();
const rejectedMentionPatternWarningCache = new Set<string>();

type MentionPatternRejectReason = Exclude<SafeRegexRejectReason, "empty">;

function warnRejectedMentionPattern(pattern: string, reason: MentionPatternRejectReason): void {
  const key = `${MENTION_PATTERN_FLAGS}::${reason}::${pattern}`;
  if (rejectedMentionPatternWarningCache.has(key)) {
    return;
  }
  rejectedMentionPatternWarningCache.add(key);
  if (rejectedMentionPatternWarningCache.size > MAX_MENTION_PATTERN_WARNING_KEYS) {
    rejectedMentionPatternWarningCache.clear();
    rejectedMentionPatternWarningCache.add(key);
  }
  debugWarn(`qqbot: mentionPattern rejected (${reason}): ${pattern}`);
}

function cacheMentionPatterns(cacheKey: string, regexes: RegExp[]): RegExp[] {
  mentionPatternCompileCache.set(cacheKey, regexes);
  if (mentionPatternCompileCache.size > MAX_MENTION_PATTERN_CACHE_KEYS) {
    mentionPatternCompileCache.clear();
    mentionPatternCompileCache.set(cacheKey, regexes);
  }
  return regexes;
}

function compileMentionPatterns(patterns: string[]): RegExp[] {
  if (patterns.length === 0) {
    return [];
  }
  const cacheKey = patterns.join("\u001f");
  const cached = mentionPatternCompileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    const result = compileSafeRegexDetailed(pattern, MENTION_PATTERN_FLAGS);
    if (result.reason === "empty") {
      continue;
    }
    if (result.regex) {
      regexes.push(result.regex);
      continue;
    }
    warnRejectedMentionPattern(result.source, result.reason);
  }
  return cacheMentionPatterns(cacheKey, regexes);
}

export function detectWasMentioned(input: DetectWasMentionedInput): boolean {
  const { eventType, mentions, content, mentionPatterns } = input;

  if (mentions?.some((m) => m.is_you)) {
    return true;
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    return true;
  }

  if (mentionPatterns?.length && content) {
    for (const regex of compileMentionPatterns(mentionPatterns)) {
      if (regex.test(content)) {
        return true;
      }
    }
  }

  return false;
}

export function hasAnyMention(input: HasAnyMentionInput): boolean {
  if (input.mentions && input.mentions.length > 0) {
    return true;
  }
  if (input.content && MENTION_TAG_RE.test(input.content)) {
    return true;
  }
  return false;
}

export function stripMentionText(text: string, mentions?: RawMention[]): string {
  if (!text || !mentions?.length) {
    return text;
  }
  let cleaned = text;
  for (const m of mentions) {
    const openid = m.member_openid ?? m.id ?? m.user_openid;
    if (!openid) {
      continue;
    }
    const tagRe = new RegExp(`<@!?${escapeRegex(openid)}>`, "g");
    if (m.is_you) {
      cleaned = cleaned.replace(tagRe, "").trim();
    } else {
      const displayName = m.nickname ?? m.username;
      if (displayName) {
        cleaned = cleaned.replace(tagRe, `@${displayName}`);
      }
    }
  }
  return cleaned;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============ Implicit mention (quoted bot message) ============

/**
 * Decide whether a quoted-reply should count as an implicit @bot.
 *
 * When the user quotes an earlier bot message, we treat the new message
 * as if it @-ed the bot, even without a literal mention. This lives in
 * the mention module (rather than with activation) because semantically
 * it answers the same question as `detectWasMentioned`:
 * "was the bot addressed by this message?".
 *
 * The `getRefEntry` callback is injected so this function does not
 * depend on the ref-index store implementation — any lookup that
 * returns `{ isBot?: boolean }` works.
 */
export function resolveImplicitMention(params: {
  refMsgIdx?: string;
  getRefEntry: (idx: string) => { isBot?: boolean } | null;
}): boolean {
  if (!params.refMsgIdx) {
    return false;
  }
  const refEntry = params.getRefEntry(params.refMsgIdx);
  return refEntry?.isBot === true;
}
