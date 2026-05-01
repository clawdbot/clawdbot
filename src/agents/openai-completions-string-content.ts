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
