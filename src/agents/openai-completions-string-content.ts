/**
 * OpenAI Chat Completions compatibility helpers. Some providers only accept
 * role/content messages with plain string content instead of text block arrays.
 */
function flattenStringOnlyCompletionContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return content;
    }
    textParts.push((item as { text: string }).text);
  }
  return textParts.join("\n");
}

/** Flatten string-only text block content arrays into newline-joined strings. */
export function flattenCompletionMessagesToStringContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const flattenedContent = flattenStringOnlyCompletionContent(content);
    if (flattenedContent === content) {
      return message;
    }
    return {
      ...message,
      content: flattenedContent,
    };
  });
}

/** Strip completion messages to role/content fields for strict providers. */
export function stripCompletionMessagesToRoleContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }
    const record = message as Record<string, unknown>;
    const stripped: Record<string, unknown> = {};
    if (Object.hasOwn(record, "role")) {
      stripped.role = record.role;
    }
    if (Object.hasOwn(record, "content")) {
      stripped.content = record.content;
    }
    return stripped;
  });
}
