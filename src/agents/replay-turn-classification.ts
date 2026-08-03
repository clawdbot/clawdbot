type AssistantTurnLike = {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
};

/** Returns true when an assistant turn contains only provider reasoning and blank text. */
export function hasOnlyAssistantReasoningContent(message: AssistantTurnLike): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = Array.isArray(message.content)
    ? message.content
    : message.content != null && typeof message.content === "object"
      ? [message.content]
      : [];
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "thinking" || record.type === "redacted_thinking") {
      hasThinking = true;
      continue;
    }
    if (record.type === "text" && typeof record.text === "string" && !record.text.trim()) {
      continue;
    }
    return false;
  }
  return hasThinking;
}

/** Returns true when a token-limited turn contains only incomplete provider reasoning. */
export function isReasoningOnlyLengthAssistantTurn(message: AssistantTurnLike): boolean {
  return message.stopReason === "length" && hasOnlyAssistantReasoningContent(message);
}
