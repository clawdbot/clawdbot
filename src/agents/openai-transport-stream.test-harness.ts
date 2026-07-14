// Verifies OpenAI-compatible streaming payloads, failures, and transport wrapping.
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { expect } from "vitest";
import { buildOpenAICompletionsParams, testing } from "./openai-transport-stream.js";

export const {
  buildOpenAIResponsesParams,
  parseTransportChunkUsage,
  resolveAzureOpenAIApiVersion,
} = testing;

export type OpenAICompletionsOutput = Parameters<typeof testing.processOpenAICompletionsStream>[1];

export type OpenAIResponsesOutput = Parameters<typeof testing.processResponsesStream>[1];

export type ResponsesApi = Extract<
  Api,
  "openai-responses" | "openai-chatgpt-responses" | "azure-openai-responses"
>;

export type CapturedStreamEvent = {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
};

export function makeCompletionsModel(
  overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
  const id = overrides.id ?? "test-model";
  return {
    id,
    name: overrides.name ?? id,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function makeResponsesModel<TApi extends ResponsesApi = "openai-responses">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  const id = overrides.id ?? "test-model";
  return {
    id,
    name: overrides.name ?? id,
    api: "openai-responses" as TApi,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<TApi>;
}

export function makeCompletionsChunk(
  delta: unknown,
  finishReason: unknown = null,
  overrides: Record<string, unknown> = {},
): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: delta as ChatCompletionChunk["choices"][number]["delta"],
        logprobs: null,
        finish_reason: finishReason as ChatCompletionChunk["choices"][number]["finish_reason"],
      },
    ],
    ...overrides,
  } as ChatCompletionChunk;
}

export function createDeepSeekCompletionsModel(): Model<"openai-completions"> {
  return makeCompletionsModel({
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    compat: { thinkingFormat: "deepseek" },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  });
}

export function createAssistantOutput(model: Model<"openai-completions">): OpenAICompletionsOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function createResponsesAssistantOutput(
  model: Model<"azure-openai-responses">,
): OpenAIResponsesOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function createAzureResponsesModel(): Model<"azure-openai-responses"> {
  return makeResponsesModel({
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    api: "azure-openai-responses",
    provider: "azure-openai-responses-devdiv",
    baseUrl: "https://example.openai.azure.com/openai/responses",
  });
}

export function neverYieldsStream(): AsyncIterable<unknown> {
  // Simulates an HTTP stream that opened but never delivered the first SSE event.
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => await new Promise<IteratorResult<unknown>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

export async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<never> {
  for (const chunk of chunks) {
    yield chunk as never;
  }
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  // Shared assertion helper for parsed transport payload/event records.
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export const openRouterModel = makeCompletionsModel({
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek v4 Flash",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  contextWindow: 128_000,
});

export const openRouterAnthropicModel = makeCompletionsModel({
  ...openRouterModel,
  id: "anthropic/claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
});

export const openRouterXaiModel = makeCompletionsModel({
  ...openRouterModel,
  id: "x-ai/grok-4.3",
  name: "Grok 4.3",
});

export const openAIModel = makeCompletionsModel({
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
});

export const nativeDeepSeekModel = makeCompletionsModel({
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
});

export const nativeZaiModel = makeCompletionsModel({
  id: "glm-5.1",
  name: "GLM 5.1",
  provider: "zai",
  baseUrl: "https://api.z.ai/api/paas/v4",
  maxTokens: 131_072,
});

export const xiaomiModel = makeCompletionsModel({
  id: "mimo-v2.5-pro",
  name: "MiMo V2.5 Pro",
  provider: "xiaomi",
  baseUrl: "https://api.xiaomimimo.com/v1",
  contextWindow: 1_048_576,
  maxTokens: 32_000,
});

export const customMiMoProxyModel = makeCompletionsModel({
  ...xiaomiModel,
  provider: "xiaomi-orbit",
  baseUrl: "https://proxy.example.com/v1",
});

export const customKimiProxyModel = makeCompletionsModel({
  id: "moonshotai/kimi-k2.6",
  name: "Kimi K2.6",
  provider: "custom-openai-proxy",
  baseUrl: "https://proxy.example.com/v1",
  contextWindow: 262_144,
  maxTokens: 32_000,
});

export const staleKimiK27Model = makeCompletionsModel({
  ...customKimiProxyModel,
  id: "kimi-k2.7-code",
  name: "Kimi K2.7 Code",
  provider: "moonshot",
  baseUrl: "https://api.moonshot.ai/v1",
  reasoning: false,
});

export const customQwenReasoningModel = makeCompletionsModel({
  id: "Qwen3.6-35B-A3B",
  name: "Qwen3.6 35B",
  provider: "custom-openai-proxy",
  baseUrl: "https://proxy.example.com/v1",
  contextWindow: 262_144,
  maxTokens: 32_000,
});

export const gemma4Model = makeCompletionsModel({
  id: "google/gemma-4-12b",
  name: "Gemma 4 12B",
  provider: "vllm",
  baseUrl: "https://proxy.example.com/v1",
  contextWindow: 262_144,
  maxTokens: 32_000,
});

export const kimiCodingProxyModel = makeCompletionsModel({
  ...customKimiProxyModel,
  id: "kimi-for-coding",
  name: "Kimi for Coding",
  provider: "kimi",
  baseUrl: "https://api.kimi.com/coding/v1",
});

export function getAssistantMessage(params: { messages: unknown }) {
  expect(Array.isArray(params.messages)).toBe(true);
  const list = params.messages as Array<Record<string, unknown>>;
  const assistant = list.find((m) => m.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant as Record<string, unknown>;
}

export function buildReplayParams(model: Model<"openai-completions">, thinkingSignature: string) {
  return buildOpenAICompletionsParams(
    model,
    {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          provider: model.provider,
          api: model.api,
          model: model.id,
          stopReason: "stop",
          timestamp: 0,
          content: [
            {
              type: "thinking",
              thinking: "Need to answer politely.",
              thinkingSignature,
            },
            { type: "text", text: "Hello!" },
          ],
        },
        { role: "user", content: "again" },
      ],
      tools: [],
    } as never,
    undefined,
  ) as { messages: unknown };
}

// issue #89660: a custom OpenAI-compatible proxy (not auto-detected as DeepSeek/
// Xiaomi/Kimi) can opt into the DeepSeek reasoning-content replay contract by
// setting compat.requiresReasoningContentOnAssistantMessages in config. getCompat
// must resolve `compat.X ?? detected.X` (matching every sibling field) instead of
// using `detected.X` alone, so the explicit config flag is honored in this transport.
export const customReasoningProxyModel = makeCompletionsModel({
  id: "my-proxy/r1-pro",
  name: "Custom Reasoning Proxy",
  provider: "custom-openai-proxy",
  baseUrl: "https://my-proxy.example.com/v1",
});
