// Line plugin module owns native mention facts carried by webhook text messages.
import type { webhook } from "@line/bot-sdk";

type LineMessageContent = webhook.MessageEvent["message"];
type LineMentionee = webhook.Mentionee;

function getLineMentionees(message: LineMessageContent): LineMentionee[] {
  return message.type === "text" ? (message.mention?.mentionees ?? []) : [];
}

// `@all` reaches every member, so it addresses the bot as surely as a mention
// LINE marked `isSelf`. Both readers below share this one predicate so mention
// gating and command text can never disagree about who was addressed.
function addressesLineBot(mentionee: LineMentionee): boolean {
  return mentionee.type === "all" || mentionee.isSelf === true;
}

export function isLineBotMentioned(message: LineMessageContent): boolean {
  return getLineMentionees(message).some(addressesLineBot);
}

export function hasAnyLineMention(message: LineMessageContent): boolean {
  return getLineMentionees(message).length > 0;
}

/**
 * Text to interpret as a command, with the mention that addressed the bot removed.
 *
 * LINE writes a mention as the plain channel display name, so no pattern can
 * tell it apart from a member's name; `mentionees[].index`/`length` (UTF-16
 * code units, the unit LINE counts text in) is the only authoritative marker.
 * Leaving it in place makes a group `@<bot> /status` parse as prose, and group
 * chats require the mention to reach the bot at all.
 */
export function resolveLineMentionStrippedText(message: LineMessageContent): string {
  const text = message.type === "text" ? message.text : "";
  const spans = getLineMentionees(message)
    .filter(addressesLineBot)
    .map((mentionee) => ({ start: mentionee.index, end: mentionee.index + mentionee.length }))
    .toSorted((left, right) => left.start - right.start);
  let stripped = "";
  let cursor = 0;
  for (const span of spans) {
    stripped += text.slice(cursor, span.start);
    // Removing an inline mention must not join neighboring text into a new
    // command token that the sender never wrote.
    if (/\S$/u.test(stripped) && /^\S/u.test(text.slice(span.end))) {
      stripped += " ";
    }
    cursor = Math.max(cursor, span.end);
  }
  return `${stripped}${text.slice(cursor)}`.trim();
}
