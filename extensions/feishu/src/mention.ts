import type { FeishuMessageEvent } from "./event-types.js";
import type { MentionTarget } from "./mention-target.types.js";
import { isFeishuGroupChatType } from "./types.js";

type FeishuMentionLike = {
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
};

export function isFeishuBroadcastMention(mention: FeishuMentionLike): boolean {
  const normalizedKey = mention.key?.trim().toLowerCase();
  if (normalizedKey === "@all" || normalizedKey === "@_all") {
    return true;
  }

  const mentionIds = [mention.id?.open_id, mention.id?.user_id, mention.id?.union_id];
  return mentionIds.some((id) => id?.trim().toLowerCase() === "all");
}

/**
 * Extract mention targets from message event (excluding the bot itself)
 */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];

  return mentions
    .filter((m) => {
      if (isFeishuBroadcastMention(m)) {
        return false;
      }
      // Exclude the bot itself
      if (botOpenId && m.id.open_id === botOpenId) {
        return false;
      }
      // Must have open_id
      return !!m.id.open_id;
    })
    .map((m) => ({
      openId: m.id.open_id!,
      name: m.name,
      key: m.key,
    }));
}

/**
 * Check if message is a mention forward request
 * Rules:
 * - Group: message mentions bot + at least one other user
 * - DM: message mentions any user (no need to mention bot)
 */
export function isMentionForwardRequest(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }

  const isDirectMessage = !isFeishuGroupChatType(event.message.chat_type);
  const userMentions = mentions.filter((m) => !isFeishuBroadcastMention(m));
  const hasOtherMention = userMentions.some((m) => m.id.open_id !== botOpenId);

  if (isDirectMessage) {
    // DM: trigger if any non-bot user is mentioned
    return hasOtherMention;
  }
  // Group: need to mention both bot and other users
  const hasBotMention = userMentions.some((m) => m.id.open_id === botOpenId);
  return hasBotMention && hasOtherMention;
}

/**
 * Format @mention for text message
 */
function formatMentionForText(target: MentionTarget): string {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}

/**
 * Format @mention for card message (lark_md)
 */
function formatMentionForCard(target: MentionTarget): string {
  return `<at id=${target.openId}></at>`;
}

/**
 * Build complete message with @mentions (text format)
 */
export function buildMentionedMessage(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForText(t));
  return `${mentionParts.join(" ")} ${message}`;
}

/**
 * Build card content with @mentions (Markdown format)
 */
export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}
