type ReplayMessage = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
};

export const ANTHROPIC_OMITTED_REASONING_TEXT = "[assistant reasoning omitted]";

function asReplayMessage(value: unknown): ReplayMessage | undefined {
  return value && typeof value === "object" ? (value as ReplayMessage) : undefined;
}

/**
 * Anthropic tool results continue the preceding assistant turn. Preserve that
 * turn's signed thinking even when the next request disables new thinking.
 */
export function findActiveAnthropicToolTurnAssistantIndex(messages: readonly unknown[]): number {
  const toolResultIds = new Set<string>();
  let index = messages.length - 1;

  while (index >= 0) {
    const message = asReplayMessage(messages[index]);
    if (message?.role !== "toolResult") {
      break;
    }
    if (typeof message.toolCallId === "string") {
      toolResultIds.add(message.toolCallId);
    }
    index -= 1;
  }

  if (toolResultIds.size === 0) {
    return -1;
  }

  const assistant = asReplayMessage(messages[index]);
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    return -1;
  }

  const toolCallIds = new Set<string>();
  for (const block of assistant.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; id?: unknown };
    if (
      (record.type === "toolCall" ||
        record.type === "tool_use" ||
        record.type === "function_call") &&
      typeof record.id === "string"
    ) {
      toolCallIds.add(record.id);
    }
  }

  return [...toolResultIds].every((toolCallId) => toolCallIds.has(toolCallId)) ? index : -1;
}
