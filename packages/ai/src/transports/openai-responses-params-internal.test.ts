import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesCompactSystemMessage } from "./openai-responses-params-internal.js";

const reasoningModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

describe("buildOpenAIResponsesCompactSystemMessage", () => {
  it("uses the developer role for reasoning models that support it", () => {
    expect(
      buildOpenAIResponsesCompactSystemMessage(reasoningModel, "Retain the conversation."),
    ).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Retain the conversation." }],
    });
  });

  it("falls back to the system role for xAI's native route, which disables the developer role", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, provider: "xai", baseUrl: "https://api.x.ai/v1" },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });

  it("uses the system role for non-reasoning models", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, reasoning: false },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });
});
