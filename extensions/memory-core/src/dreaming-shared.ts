// Memory Core plugin module implements dreaming shared behavior.
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export { asNullableRecord as asRecord, normalizeOptionalString as normalizeTrimmedString };
export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function extractAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asNullableRecord(messages[index]);
    if (message?.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .flatMap((part) => {
          const item = asNullableRecord(part);
          return (item?.type === "text" || item?.type === "output_text") &&
            typeof item.text === "string"
            ? [item.text]
            : [];
        })
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

export function includesSystemEventToken(cleanedBody: string, eventText: string): boolean {
  const normalizedBody = normalizeOptionalString(cleanedBody);
  const normalizedEventText = normalizeOptionalString(eventText);
  if (!normalizedBody || !normalizedEventText) {
    return false;
  }
  if (normalizedBody === normalizedEventText) {
    return true;
  }
  return normalizedBody.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === normalizedEventText) {
      return true;
    }
    // Isolated cron turns wrap the payload with a `[cron:<id>] ...` prefix; strip
    // that one known wrapper before matching so the dream sentinel still triggers
    // without falling back to a broad substring match (which would let any user
    // message embedding the token surface as a dream cron firing).
    return trimmed.replace(/^\[cron:[^\]]+\]\s*/, "") === normalizedEventText;
  });
}
