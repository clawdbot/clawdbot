import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { expect } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiProviderRequestPolicyInput,
} from "../host.js";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import type { processCompletionsStream } from "./openai-completions-stream.js";

export type OpenAICompletionsOutput = Parameters<typeof processCompletionsStream>[1];

export type CapturedStreamEvent = {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
};

type RequestTransportConfig = {
  proxy?: unknown;
  tls?: unknown;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
};

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function resolveTestEndpointClass(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return "default";
  }
  const host = new URL(baseUrl).hostname;
  const exactClasses: Record<string, string> = {
    "api.openai.com": "openai-public",
    "api.cerebras.ai": "cerebras-native",
    "api.x.ai": "xai-native",
    "api.moonshot.ai": "moonshot-native",
    "api.moonshot.cn": "moonshot-native",
    "llm.chutes.ai": "chutes-native",
    "api.z.ai": "zai-native",
    "api.deepseek.com": "deepseek-native",
    "api.mistral.ai": "mistral-public",
    "dashscope.aliyuncs.com": "modelstudio-native",
    "generativelanguage.googleapis.com": "google-generative-ai",
    "127.0.0.1": "local",
    localhost: "local",
  };
  const exactClass = exactClasses[host];
  if (exactClass) {
    return exactClass;
  }
  if (
    host.endsWith(".openai.azure.com") ||
    host.endsWith(".services.ai.azure.com") ||
    host.endsWith(".cognitiveservices.azure.com")
  ) {
    return "azure-openai";
  }
  if (host.endsWith("openrouter.ai")) {
    return "openrouter";
  }
  if (host.endsWith("opencode.ai")) {
    return "opencode-native";
  }
  if (host.endsWith("xiaomimimo.com")) {
    return "xiaomi-native";
  }
  if (host.endsWith("aiplatform.googleapis.com")) {
    return "google-vertex";
  }
  return "custom";
}

function resolveTestCapabilities(
  input: AiProviderRequestPolicyInput,
): AiProviderRequestCapabilities {
  const endpointClass = resolveTestEndpointClass(input.baseUrl);
  const provider = input.provider;
  const knownProviderFamily =
    provider === "moonshotai" || provider === "moonshotai-cn"
      ? "moonshot"
      : provider === "dashscope" || provider === "modelstudio" || provider === "qwen"
        ? "modelstudio"
        : provider === "openai" || provider === "azure-openai"
          ? "openai-family"
          : (provider ?? "unknown");
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai" ||
    endpointClass === "azure-openai";
  return {
    endpointClass,
    knownProviderFamily,
    supportsNativeStreamingUsageCompat:
      endpointClass === "moonshot-native" || endpointClass === "modelstudio-native",
    supportsOpenAICompletionsStreamingUsageCompat: provider === "volcengine-plan",
    usesExplicitProxyLikeEndpoint: usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint,
    allowsAnthropicServiceTier: false,
  };
}

const baseTestHost = getAiTransportHost();
configureAiTransportHost({
  ...baseTestHost,
  buildModelFetch: () => async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("application/json")) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(`data: ${await response.text()}\n\ndata: [DONE]\n\n`, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  resolveOpenAIStrictToolSetting: (_model, options) =>
    options?.supportsStrictMode ? true : undefined,
  resolveProviderEndpointClass: resolveTestEndpointClass,
  resolveProviderRequestCapabilities: resolveTestCapabilities,
  resolveModelRequestTimeoutMs: (model) => {
    const value = (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : undefined;
  },
});

export function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: RequestTransportConfig | undefined,
): TModel {
  if (!request) {
    return model;
  }
  const next = { ...model } as TModel & {
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]?: RequestTransportConfig;
  };
  next[MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL] = request;
  return next;
}

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

export async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<never> {
  for (const chunk of chunks) {
    yield chunk as never;
  }
}

export function neverYieldsStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => await new Promise<IteratorResult<unknown>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
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
  const assistant = list.find((message) => message.role === "assistant");
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

export const customReasoningProxyModel = makeCompletionsModel({
  id: "my-proxy/r1-pro",
  name: "Custom Reasoning Proxy",
  provider: "custom-openai-proxy",
  baseUrl: "https://my-proxy.example.com/v1",
});
