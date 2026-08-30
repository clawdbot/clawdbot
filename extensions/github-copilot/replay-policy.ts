// Github Copilot plugin module implements replay policy behavior.
import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildStrictAnthropicReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";

const OMITTED_COPILOT_REASONING_TEXT = "[assistant reasoning omitted]";

// Copilot routes Claude over the real Anthropic Messages transport, so transport
// identity - not the model id - owns replay behavior. The wire patch in
// stream.ts gates on the same signal; keep the two in sync.
function isCopilotAnthropicTransport(modelApi?: string | null): boolean {
  return modelApi === "anthropic-messages";
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

export function buildGithubCopilotReplayPolicy(
  ctx: ProviderReplayPolicyContext,
): ProviderReplayPolicy | undefined {
  if (!isCopilotAnthropicTransport(ctx.modelApi)) {
    return undefined;
  }
  return buildStrictAnthropicReplayPolicy({
    // Unconditional: Copilot strips replayed thinking for every Claude model, so
    // it never owns signed-thinking replay. The shared by-model helper would
    // re-enable it for thinking-preserving Claude ids.
    dropThinkingBlocks: true,
    // wrapCopilotAnthropicStream rewrites tool ids on the wire and deliberately
    // leaves the persisted transcript untouched. Core-side rewriting would
    // mutate that transcript instead.
    sanitizeToolCallIds: false,
  });
}

export function sanitizeGithubCopilotReplayHistory(ctx: ProviderSanitizeReplayHistoryContext) {
  return ctx.modelApi === "openai-responses" || isCopilotAnthropicTransport(ctx.modelApi)
    ? stripCopilotAssistantThinkingMessages(ctx.messages)
    : ctx.messages;
}
