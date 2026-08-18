import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesCompactSystemMessage,
  buildOpenAIResponsesParams,
} from "./openai-responses-params-internal.js";

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

const summaryModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

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

describe("buildOpenAIResponsesParams reasoning summary", () => {
  it("preserves null reasoning summary with explicit effort", () => {
    const params = buildOpenAIResponsesParams(summaryModel, context, {
      reasoningEffort: "medium",
      reasoningSummary: null,
    });

    expect(params.reasoning).toMatchObject({ effort: "medium", summary: null });
  });

  it("preserves null reasoning summary without explicit effort", () => {
    const params = buildOpenAIResponsesParams(summaryModel, context, {
      reasoningSummary: null,
    });

    // gpt-5.5 omitted-effort default is high (native Codex defaults medium).
    expect(params.reasoning).toMatchObject({ effort: "high", summary: null });
  });

  it("defaults omitted reasoning summary to auto", () => {
    const params = buildOpenAIResponsesParams(summaryModel, context, {
      reasoningEffort: "medium",
    });

    expect(params.reasoning).toMatchObject({ effort: "medium", summary: "auto" });
  });
});
