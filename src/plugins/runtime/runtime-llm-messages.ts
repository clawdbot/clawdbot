import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Api, Message } from "../../llm/types.js";
import type { LlmCompleteParams } from "./types-core.js";

export function buildRuntimeLlmSystemPrompt(params: LlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

export function buildRuntimeLlmMessages(params: {
  request: LlmCompleteParams;
  provider: string;
  model: string;
  api: Api;
}): Message[] {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content, timestamp: now }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: now,
          },
    );
}
