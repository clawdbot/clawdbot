export type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
};

const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;

export function stripTelegramInternalPrefixes(to: string): string {
  let trimmed = to.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      // Legacy internal form: `telegram:group:<id>` (still emitted by session keys).
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

export function normalizeTelegramChatId(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return undefined;
  }
  if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) {
    return stripped;
  }
  return undefined;
}

export function isNumericTelegramChatId(raw: string): boolean {
  return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}

export function normalizeTelegramLookupTarget(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return undefined;
  }
  if (isNumericTelegramChatId(stripped)) {
    return stripped;
  }
  const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
  if (tmeMatch?.[1]) {
    return `@${tmeMatch[1]}`;
  }
  if (stripped.startsWith("@")) {
    const handle = stripped.slice(1);
    if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) {
      return undefined;
    }
    return `@${handle}`;
  }
  if (TELEGRAM_USERNAME_REGEX.test(stripped)) {
    return `@${stripped}`;
  }
  return undefined;
}

/**
 * Parse a Telegram delivery target into chatId and optional topic/thread ID.
 *
 * Supported formats:
 * - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
 * - `chatId:topicId` (numeric topic/thread ID)
 * - `chatId:topic:topicId` (explicit topic marker; preferred)
 */
function resolveTelegramChatType(chatId: string): "direct" | "group" | "unknown" {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (isNumericTelegramChatId(trimmed)) {
    return trimmed.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}

export function parseTelegramTarget(to: string): TelegramTarget {
  const normalized = stripTelegramInternalPrefixes(to);

  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
      chatType: resolveTelegramChatType(topicMatch[1]),
    };
  }

  const colonMatch = /^(.+):(\d+)$/.exec(normalized);
  if (colonMatch) {
    return {
      chatId: colonMatch[1],
      messageThreadId: Number.parseInt(colonMatch[2], 10),
      chatType: resolveTelegramChatType(colonMatch[1]),
    };
  }

  return {
    chatId: normalized,
    chatType: resolveTelegramChatType(normalized),
  };
}

export function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown" {
  return parseTelegramTarget(target).chatType;
}
