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
      } catch {}
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
