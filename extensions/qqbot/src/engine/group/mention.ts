/**
 * QQBot group @mention detection and text normalization.
 *
 * Pure functions extracted from the standalone build (`openclaw-qqbot/src/
 * channel.ts::detectWasMentioned` / `stripMentionText`) plus the helper
 * `hasAnyMention` that previously lived inline in `gateway.ts` and the
 * `resolveImplicitMention` predicate that decides whether a quoted-reply
 * should count as an implicit @bot.
 *
 * Keeping these helpers together makes it easier to test the group gating
 * pipeline and lets both the built-in and standalone builds share a
 * single mention-detection implementation.
 */

// ============ Types ============

/**
 * Raw mention entry shape used across QQ Bot group events.
 *
 * QQ's `mentions` array uses slightly different field names on different
 * event types (the bot's self-mention comes as `is_you: true`; user IDs
 * can appear in any of `member_openid` / `id` / `user_openid`). This type
 * captures the union so callers don't have to worry about which variant.
 */
export interface RawMention {
  /** Whether this mention targets the bot itself. */
  is_you?: boolean;
  /** Whether the mention target is another bot. */
  bot?: boolean;
  /** Member openid in group chats. */
  member_openid?: string;
  /** Event-level id (guild context). */
  id?: string;
  /** User openid (C2C context). */
  user_openid?: string;
  /** Display name. */
  nickname?: string;
  /** Alternative display name. */
  username?: string;
  /** @all / @single scope (QQ guild events). */
  scope?: "all" | "single";
}

/** Input for {@link detectWasMentioned}. */
export interface DetectWasMentionedInput {
  /**
   * Raw event type. `"GROUP_AT_MESSAGE_CREATE"` unambiguously identifies
   * that the bot was @-ed, even when the mentions array is empty.
   */
  eventType?: string;
  mentions?: RawMention[];
  /** Raw message content — used as a regex fallback via `mentionPatterns`. */
  content?: string;
  /**
   * Regex patterns matched against `content` when neither `mentions.is_you`
   * nor `eventType` prove a bot mention. Invalid patterns are ignored.
   */
  mentionPatterns?: string[];
}

/** Input for {@link hasAnyMention}. */
export interface HasAnyMentionInput {
  mentions?: RawMention[];
  content?: string;
}

// ============ Constants ============

/** Regex detecting `<@openid>` / `<@!openid>` mention tags in raw content. */
const MENTION_TAG_RE = /<@!?\w+>/;

// ============ Public API ============

/**
 * Detect whether the inbound message explicitly targets the bot.
 *
 * Priority order:
 *   1. `mentions[].is_you === true`           (most reliable)
 *   2. `eventType === "GROUP_AT_MESSAGE_CREATE"` (QQ-level @bot event)
 *   3. regex match on any of `mentionPatterns` (fallback, e.g. "@bot-name")
 *
 * Returns `false` for direct messages or when no signal is found.
 */
export function detectWasMentioned(input: DetectWasMentionedInput): boolean {
  const { eventType, mentions, content, mentionPatterns } = input;

  if (mentions?.some((m) => m.is_you)) {
    return true;
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    return true;
  }

  if (mentionPatterns?.length && content) {
    for (const pattern of mentionPatterns) {
      if (!pattern) {
        continue;
      }
      try {
        if (new RegExp(pattern, "i").test(content)) {
          return true;
        }
      } catch {
        // Invalid regex — skip silently; bad patterns must not crash the pipeline.
      }
    }
  }

  return false;
}

/**
 * Report whether the message contains **any** @mention (not necessarily @bot).
 *
 * Used by the gating layer to decide whether to bypass mention requirements
 * for control commands. A control command like `/stop` that also @-s another
 * user should NOT bypass the mention gate — the `@other-user` prefix is a
 * strong signal that the command wasn't addressed to the bot.
 */
export function hasAnyMention(input: HasAnyMentionInput): boolean {
  if (input.mentions && input.mentions.length > 0) {
    return true;
  }
  if (input.content && MENTION_TAG_RE.test(input.content)) {
    return true;
  }
  return false;
}

/**
 * Clean up `<@openid>` mention tags in raw QQ group content.
 *
 * - For the bot's own mention (`is_you === true`): the tag is removed
 *   outright so prompts don't contain visible `<@BOTID>` garbage.
 * - For other mentioned users: the tag is replaced with `@nickname` (or
 *   `@username`) for readability. Entries without a display name are left
 *   as-is (rare in practice).
 *
 * Returns the original text unchanged when `text` or `mentions` is empty.
 */
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
    // RegExp: match both `<@openid>` and `<@!openid>` variants.
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

// ============ Internal helpers ============

/** Escape characters that carry regex meaning. */
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
