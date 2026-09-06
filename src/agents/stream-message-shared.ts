/**
 * Assistant stream message builders.
 *
 * Centralizes zero-cost usage records and assistant message construction for simple stream transports.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage, StopReason, Usage } from "../llm/types.js";

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

export function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    // Provider adapters normalize input to uncached tokens before this shared builder.
    totalTokens: params.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function buildAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

// Legacy error content remains readable without replaying provider diagnostics.
export const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

export function isStreamErrorFallbackContent(content: unknown): boolean {
  if (content == null) {
    return true;
  }
  if (typeof content === "string") {
    return !content.trim() || content.trim() === STREAM_ERROR_FALLBACK_TEXT;
  }
  return (
    Array.isArray(content) &&
    content.every((value) => {
      const block = asOptionalRecord(value);
      return (
        block &&
        (block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
        typeof block.text === "string" &&
        isStreamErrorFallbackContent(block.text)
      );
    })
  );
}

export function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessage({
      model: params.model,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      stopReason: "error",
      usage: buildUsageWithNoCost({}),
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}
