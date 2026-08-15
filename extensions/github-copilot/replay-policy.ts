// Github Copilot plugin module implements replay policy behavior.
import type { ProviderSanitizeReplayHistoryContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const OMITTED_COPILOT_REASONING_TEXT = "[assistant reasoning omitted]";

function isCopilotClaudeModel(modelId?: string | null): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("claude");
}

function isThinkingBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

export function stripCopilotAssistantThinkingMessages<T>(messages: T[]): T[] {
  let touched = false;
  const sanitized = messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) {
      return message;
    }
    const content = record.content.filter((block) => !isThinkingBlock(block));
    if (content.length === record.content.length) {
      return message;
    }
    touched = true;
    return {
      ...message,
      content:
        content.length > 0 ? content : [{ type: "text", text: OMITTED_COPILOT_REASONING_TEXT }],
    };
  });
  return touched ? sanitized : messages;
}

export function buildGithubCopilotReplayPolicy(modelId?: string) {
  return isCopilotClaudeModel(modelId)
    ? {
        dropThinkingBlocks: true,
      }
    : {};
}

export function sanitizeGithubCopilotReplayHistory(ctx: ProviderSanitizeReplayHistoryContext) {
  return isCopilotClaudeModel(ctx.modelId)
    ? stripCopilotAssistantThinkingMessages(ctx.messages)
    : ctx.messages;
}
