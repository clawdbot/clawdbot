// Telegram plugin module implements raw update log behavior.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_RAW_UPDATE_STRING = 500;
const MAX_RAW_UPDATE_ARRAY = 20;
const REDACTED_TELEGRAM_FIELD = "[redacted]";
const TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS = new Set([
  "added_to_attachment_menu",
  "author_signature",
  "caption",
  "chat_instance",
  "data",
  "email",
  "bio",
  "description",
  "explanation",
  "file_id",
  "file_unique_id",
  "first_name",
  "invite_link",
  "is_premium",
  "language_code",
  "latitude",
  "last_name",
  "longitude",
  "name",
  "phone_number",
  "question",
  "query",
  "text",
  "title",
  "url",
  "username",
  "vcard",
]);
const TELEGRAM_RAW_UPDATE_ALLOWED_ID_KEYS = new Set(["message_id", "update_id"]);
const TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS = new Set([
  "chat_id",
  "custom_emoji_id",
  "inline_message_id",
  "migrate_from_chat_id",
  "migrate_to_chat_id",
  "option_ids",
  "poll_id",
  "sender_chat_id",
  "user_id",
  "user_chat_id",
]);

function shouldRedactTelegramRawUpdateValue(key: string, parentKey: string | undefined): boolean {
  if (!key) {
    return false;
  }
  if (TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS.has(key)) {
    return true;
  }
  if (TELEGRAM_RAW_UPDATE_ALLOWED_ID_KEYS.has(key)) {
    return false;
  }
  if (TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS.has(key)) {
    return true;
  }
  if (key === "id" || key.endsWith("_id") || key.endsWith("_ids")) {
    return parentKey !== undefined;
  }
  return false;
}

function isTelegramUserObject(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "number" &&
    typeof value.is_bot === "boolean" &&
    typeof value.first_name === "string"
  );
}

export function stringifyTelegramRawUpdateForLog(update: unknown): string {
  const seen = new WeakSet<object>();
  const transform = (value: unknown, key = "", parentKey?: string): unknown => {
    if (shouldRedactTelegramRawUpdateValue(key, parentKey)) {
      return REDACTED_TELEGRAM_FIELD;
    }
    if (typeof value === "string") {
      return value.length > MAX_RAW_UPDATE_STRING
        ? `${truncateUtf16Safe(value, MAX_RAW_UPDATE_STRING)}...`
        : value;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_RAW_UPDATE_ARRAY).map((item) => transform(item, key, key));
      if (value.length > MAX_RAW_UPDATE_ARRAY) {
        items.push(`...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`);
      }
      return items;
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (isTelegramUserObject(record)) {
        return REDACTED_TELEGRAM_FIELD;
      }
      const redacted: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(record)) {
        redacted[entryKey] = transform(entryValue, entryKey, key);
      }
      return redacted;
    }
    return value;
  };
  return JSON.stringify(transform(update ?? null));
}
