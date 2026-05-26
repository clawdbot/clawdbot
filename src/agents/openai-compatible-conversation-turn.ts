function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    return hasNonEmptyString(record.text);
  }
  return true;
}

function hasNonEmptyMessageContent(content: unknown): boolean {
  if (hasNonEmptyString(content)) {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(hasNonEmptyContentPart);
}

function hasAssistantToolCall(message: Record<string, unknown>): boolean {
  const toolCalls = message.tool_calls;
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((toolCall) => {
      return Boolean(toolCall && typeof toolCall === "object");
    })
  );
}

export function hasOpenAICompatibleConversationTurn(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "user") {
      return hasNonEmptyMessageContent(record.content);
    }
    if (record.role === "assistant") {
      return hasNonEmptyMessageContent(record.content) || hasAssistantToolCall(record);
    }
    return false;
  });
}
