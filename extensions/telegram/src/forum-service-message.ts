/** Telegram forum-topic service-message fields (Bot API). */
export const TELEGRAM_FORUM_SERVICE_FIELDS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
] as const;

/**
 * Returns `true` when the message is a Telegram forum service message (e.g.
 * "Topic created"). These auto-generated messages carry one of the
 * `forum_topic_*` / `general_forum_topic_*` fields and should not count as
 * regular bot replies for implicit-mention purposes.
 */
export function isTelegramForumServiceMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const messageRecord = msg as Record<(typeof TELEGRAM_FORUM_SERVICE_FIELDS)[number], unknown>;
  return TELEGRAM_FORUM_SERVICE_FIELDS.some(
    (field) => field in messageRecord && messageRecord[field] != null,
  );
}
