// Imported by openai-transport-stream.test.ts to keep its mocked suite in one Vitest module graph.
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  openRouterModel,
  openRouterAnthropicModel,
  openRouterXaiModel,
  openAIModel,
  nativeDeepSeekModel,
  nativeZaiModel,
  xiaomiModel,
  customMiMoProxyModel,
  customKimiProxyModel,
  staleKimiK27Model,
  customQwenReasoningModel,
  gemma4Model,
  kimiCodingProxyModel,
  getAssistantMessage,
  buildReplayParams,
  customReasoningProxyModel,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("buildOpenAICompletionsParams sanitizes reasoning replay fields", () => {
  it.each(["reasoning_details", "reasoning_content", "reasoning", "reasoning_text"])(
    "strips %s from stock OpenAI Chat Completions assistant replay",
    (thinkingSignature) => {
      const assistant = getAssistantMessage(buildReplayParams(openAIModel, thinkingSignature));

      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning_content");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    },
  );

  it("normalizes OpenRouter string reasoning_details to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_details"));

    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    ["Anthropic", openRouterAnthropicModel],
    ["xAI", openRouterXaiModel],
  ] as const)("strips OpenRouter %s non-replayable reasoning fields", (_label, model) => {
    for (const thinkingSignature of [
      "reasoning_details",
      "reasoning_content",
      "reasoning",
      "reasoning_text",
    ]) {
      const assistant = getAssistantMessage(buildReplayParams(model, thinkingSignature));

      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning_content");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    }
  });

  it.each(["reasoning", "reasoning_content"])(
    "preserves OpenRouter %s string reasoning replay",
    (thinkingSignature) => {
      const assistant = getAssistantMessage(buildReplayParams(openRouterModel, thinkingSignature));

      expect(assistant[thinkingSignature]).toBe("Need to answer politely.");
    },
  );

  it("strips empty-string reasoning_content from OpenRouter assistant replay", () => {
    const params = buildOpenAICompletionsParams(
      openRouterModel,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read config" },
          {
            role: "assistant",
            provider: "openrouter",
            api: "openai-completions",
            model: "deepseek/deepseek-v4-pro",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "reasoning_content",
              },
              {
                type: "toolCall",
                id: "call_1",
                name: "read_file",
                arguments: { path: "config.json" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            content: [{ type: "text", text: "{ }" }],
            isError: false,
            timestamp: 1,
          },
          { role: "user", content: "continue" },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages: Array<Record<string, unknown>> };

    const assistantMessages = params.messages.filter((msg) => msg.role === "assistant");
    for (const msg of assistantMessages) {
      expect(msg).not.toHaveProperty("reasoning_content");
    }
  });

  it.each([
    ["DeepSeek", nativeDeepSeekModel],
    ["Z.AI", nativeZaiModel],
  ] as const)("preserves native %s reasoning_content replay", (_label, model) => {
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
  });

  it.each([
    ["DeepSeek", nativeDeepSeekModel],
    ["Z.AI", nativeZaiModel],
  ] as const)("strips non-native %s reasoning replay fields", (_label, model) => {
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_details"));

    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_text");
  });

  it("normalizes OpenRouter reasoning_text to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_text"));

    expect(assistant).not.toHaveProperty("reasoning_text");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    {
      label: "preserves reasoning_content replay for custom reasoning model metadata",
      model: customQwenReasoningModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for Gemma 4 openai-completions models",
      model: gemma4Model,
      assertSanitizedFields: true,
    },
    {
      label: "preserves DeepSeek-style reasoning_content replay for Xiaomi MiMo",
      model: xiaomiModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for custom MiMo proxy routes",
      model: customMiMoProxyModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for custom MiMo V2.6 proxy routes",
      model: { ...customMiMoProxyModel, id: "xiaomi/mimo-v2.6-pro" },
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for custom Kimi K2 proxy routes",
      model: customKimiProxyModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves Kimi K2.7 reasoning_content replay with stale reasoning metadata",
      model: staleKimiK27Model,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for Kimi Coding OpenAI-compatible routes",
      model: kimiCodingProxyModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for suffixed reasoning model ids",
      model: { ...customMiMoProxyModel, id: "xiaomi/mimo-v2.5-pro:cloud" },
      assertSanitizedFields: false,
    },
    {
      label: "preserves reasoning_content replay for prefixed reasoning model ids",
      model: { ...customKimiProxyModel, id: "hf:moonshotai/kimi-k2-thinking" },
      assertSanitizedFields: false,
    },
  ] as const)("$label", ({ model, assertSanitizedFields }) => {
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    if (assertSanitizedFields) {
      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    }
  });

  // Regression for #87575: OpenCode Zen exposes DeepSeek V4 with a `-free`
  // tier suffix that does not change the upstream replay contract. Without
  // matching the base id we stripped reasoning_content from the follow-up
  // request and DeepSeek rejected the assistant turn with HTTP 400.
  it.each([
    [
      "OpenCode Zen DeepSeek V4 Flash Free",
      {
        id: "deepseek-v4-flash-free",
        name: "DeepSeek V4 Flash Free",
        api: "openai-completions" as const,
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 8192,
      },
    ],
    [
      "OpenRouter MiMo V2 Pro Free",
      {
        ...customMiMoProxyModel,
        id: "xiaomi/mimo-v2-pro-free",
      },
    ],
    [
      "OpenRouter Kimi K2 Thinking Free",
      {
        ...customKimiProxyModel,
        id: "moonshotai/kimi-k2-thinking-free",
      },
    ],
  ] as const)("preserves reasoning_content replay despite the %s tier suffix", (_label, model) => {
    const assistant = getAssistantMessage(
      buildReplayParams(model as Model<"openai-completions">, "reasoning_content"),
    );

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_text");
  });

  it("preserves OpenRouter array reasoning_details from tool-call signatures", () => {
    const reasoningDetail = { type: "reasoning.encrypted", id: "rs_1", data: "ciphertext" };
    const params = buildOpenAICompletionsParams(
      openRouterModel,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "lookup" },
          {
            role: "assistant",
            provider: "openrouter",
            api: "openai-completions",
            model: "deepseek/deepseek-v4-flash",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "lookup",
                arguments: { query: "weather" },
                thoughtSignature: JSON.stringify(reasoningDetail),
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "sunny" }],
            isError: false,
            timestamp: 1,
          },
          { role: "user", content: "answer" },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages: unknown };

    const assistant = getAssistantMessage(params);
    expect(assistant.reasoning_details).toEqual([reasoningDetail]);
  });

  it("honors compat.requiresReasoningContentOnAssistantMessages from config on a custom provider (#89660)", () => {
    const resolved = testing.getCompat({
      ...customReasoningProxyModel,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    } as never);

    expect(resolved.requiresReasoningContentOnAssistantMessages).toBe(true);
  });

  it("falls back to detection (false) for the same custom provider when the flag is absent", () => {
    const resolved = testing.getCompat(customReasoningProxyModel as never);

    expect(resolved.requiresReasoningContentOnAssistantMessages).toBe(false);
  });
});
