import type { ClickClackClient } from "../http-client.js";

// JSON-escape plus Unicode line separators so one history record stays one line.
function discussionRecordJson(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/gu,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Renders channel history as line-per-message records for the discussion tool. */
export function formatDiscussionHistory(
  history: Awaited<ReturnType<ClickClackClient["latestChannelMessages"]>>,
): string {
  const text = history.messages
    .map((message) => {
      const author =
        message.author?.display_name || message.author?.handle || message.author_id || "Unknown";
      return `timestamp=${discussionRecordJson(message.created_at)} [Author ${discussionRecordJson(author)} id=${discussionRecordJson(message.author_id)}] text=${discussionRecordJson(message.body)}`;
    })
    .join("\n");
  const truncationNote = history.truncated
    ? "\n[History scan reached its safety bound; older active threads may be omitted.]"
    : "";
  return text ? `${text}${truncationNote}` : "";
}
