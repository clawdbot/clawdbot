import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

function emptyContext(systemPrompt: string | undefined = "system") {
  return { systemPrompt, messages: [], tools: [] } as never;
}

function weatherToolContext(systemPrompt = "system") {
  return {
    systemPrompt,
    messages: [],
    tools: [
      {
        name: "get_weather",
        description: "Get weather information",
        parameters: { type: "object", properties: {} },
      },
    ],
  } as never;
}

function toolHistoryContext(systemPrompt = "You are a helpful assistant") {
  return {
    systemPrompt,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_abc",
            name: "get_weather",
            arguments: "{}",
          },
        ],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "sunny" }],
        toolCallId: "call_abc",
      },
    ],
  } as never;
}

function toolChoiceModel(native: boolean) {
  return makeCompletionsModel(
    native
      ? {
          id: "gpt-5.4",
          name: "GPT-5.4",
          reasoning: false,
          contextWindow: 4096,
          maxTokens: 2048,
        }
      : {
          id: "test-model",
          name: "Test Model",
          provider: "vllm",
          baseUrl: "http://localhost:8000/v1",
          reasoning: false,
          contextWindow: 4096,
          maxTokens: 2048,
        },
  );
}

describe("openai completions params", () => {
  it("uses Mistral compat defaults for direct Mistral completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        api: "openai-completions",
        provider: "mistral",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      emptyContext(),
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses Mistral compat defaults for custom providers on native Mistral hosts", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        api: "openai-completions",
        provider: "custom-mistral-host",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      emptyContext(),
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("defaults tool_choice to auto for proxy-like openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(false),
      weatherToolContext("You are a helpful assistant"),
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "auto");
  });

  it("does not send tool_choice by default for native openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(true),
      weatherToolContext("You are a helpful assistant"),
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("sends tool_choice when explicitly configured", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(false),
      weatherToolContext("You are a helpful assistant"),
      {
        toolChoice: "required",
      },
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "required");
  });

  it("omits empty tools and tool_choice for proxy-like openai-completions endpoints when context.tools is []", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(false),
      emptyContext("You are a helpful assistant"),
      undefined,
    );

    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("omits tools for proxy-like openai-completions endpoints when only prior tool history is present", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(false),
      toolHistoryContext(),
      undefined,
    );

    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("preserves empty tools array for native openai-completions endpoints (existing behavior)", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(true),
      emptyContext("You are a helpful assistant"),
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect((params as { tools: unknown[] }).tools).toEqual([]);
  });

  it("preserves tools: [] fallback for native openai-completions endpoints when only prior tool history is present (existing behavior)", () => {
    const params = buildOpenAICompletionsParams(
      toolChoiceModel(true),
      toolHistoryContext(),
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect((params as { tools: unknown[] }).tools).toEqual([]);
  });
});
