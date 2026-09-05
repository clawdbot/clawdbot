// Numeric/topic target subset for lightweight heartbeat and outbound test plugins.
// The root Telegram integration suite checks classification against the real plugin.
export function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.replace(/^telegram:/i, "").trim();
  const topicMatch = withoutPrefix.match(/^(.*):topic:(\d+)$/i);
  const colonMatch = withoutPrefix.match(/^(-?\d+):(\d+)$/i);
  const chatId = topicMatch?.[1]?.trim() || colonMatch?.[1] || withoutPrefix;
  const messageThreadId = topicMatch?.[2]
    ? Number.parseInt(topicMatch[2], 10)
    : colonMatch?.[2]
      ? Number.parseInt(colonMatch[2], 10)
      : undefined;
  const chatType = /^-?\d+$/.test(chatId)
    ? chatId.startsWith("-")
      ? "group"
      : "direct"
    : "unknown";
  return { chatId, messageThreadId, chatType };
}
