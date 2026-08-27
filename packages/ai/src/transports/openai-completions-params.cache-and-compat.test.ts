import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

function emptyContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

function lookupWeatherContext(
  parameters: Record<string, unknown> = { type: "object", properties: {} },
) {
  return {
    systemPrompt: "system",
    messages: [],
    tools: [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters,
      },
    ],
  } as never;
}

function promptCacheModel() {
  return {
    id: "custom-model",
    name: "Custom Model",
    api: "openai-completions",
    provider: "custom-cpa",
    baseUrl: "https://proxy.example.com/v1",
    compat: { supportsPromptCacheKey: true },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  } as unknown as Model<"openai-completions">;
}

describe("openai completions params", () => {
  it("uses system role and streaming usage compat for native Qwen completions providers", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        provider: "qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        compat: { supportsUsageInStreaming: true },
      }),
      emptyContext(),
      undefined,
    ) as {
      messages?: Array<{ role?: string }>;
      stream_options?: { include_usage?: boolean };
    };

    expect(params.messages?.[0]?.role).toBe("system");
    expect(params.stream_options?.include_usage).toBe(true);
  });

  it("enables streaming usage compat for generic providers on native DashScope endpoints", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "glm-5",
        name: "GLM-5",
        provider: "generic",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        compat: { supportsUsageInStreaming: true },
      }),
      emptyContext(),
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options?.include_usage).toBe(true);
  });

  it("honors explicit streaming usage compat for configured custom providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-completions",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsUsageInStreaming: true },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      } as unknown as Model<"openai-completions">,
      emptyContext(),
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options?.include_usage).toBe(true);
  });

  it("includes stream_options.include_usage for Volcengine CodingPlan", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "ark-code-latest",
        name: "Ark Coding Plan",
        provider: "volcengine-plan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        reasoning: false,
        contextWindow: 256000,
        maxTokens: 4096,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("includes stream_options.include_usage for known local backends like llama-cpp", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "llama-3",
        name: "Llama 3",
        provider: "llama-cpp",
        baseUrl: "http://localhost:8080/v1",
        reasoning: false,
        contextWindow: 8192,
        maxTokens: 4096,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      stream_options?: { include_usage?: boolean };
    };

    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("forwards prompt_cache_key for opted-in OpenAI-compatible completions providers", () => {
    const params = buildOpenAICompletionsParams(promptCacheModel(), emptyContext(), {
      sessionId: "session-123",
      promptCacheKey: "cron-cache-key",
    }) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("cron-cache-key");
  });

  it("omits prompt_cache_key for completions when caching is disabled or not opted in", () => {
    const baseModel = makeCompletionsModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: false,
      contextWindow: 32768,
    });
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const disabled = buildOpenAICompletionsParams(
      {
        ...baseModel,
        compat: { supportsPromptCacheKey: true },
      } as unknown as Model<"openai-completions">,
      context,
      { sessionId: "session-123", promptCacheKey: "cron-cache-key", cacheRetention: "none" },
    ) as { prompt_cache_key?: string };
    const notOptedIn = buildOpenAICompletionsParams(baseModel, context, {
      sessionId: "session-123",
    }) as { prompt_cache_key?: string };

    expect(disabled.prompt_cache_key).toBeUndefined();
    expect(notOptedIn.prompt_cache_key).toBeUndefined();
  });

  it("emits prompt_cache_retention=24h for completions when cacheRetention is long", () => {
    const model = promptCacheModel();
    const context = emptyContext();

    const longRetention = buildOpenAICompletionsParams(model, context, {
      sessionId: "session-123",
      cacheRetention: "long",
    }) as { prompt_cache_key?: string; prompt_cache_retention?: string };

    expect(longRetention.prompt_cache_key).toBe("session-123");
    expect(longRetention.prompt_cache_retention).toBe("24h");
  });

  it("omits prompt_cache_retention for completions when cacheRetention is short or unset", () => {
    const model = promptCacheModel();
    const context = emptyContext();

    const shortRetention = buildOpenAICompletionsParams(model, context, {
      sessionId: "session-123",
      cacheRetention: "short",
    });
    const defaultRetention = buildOpenAICompletionsParams(model, context, {
      sessionId: "session-123",
    });

    expect(shortRetention).not.toHaveProperty("prompt_cache_retention");
    expect(defaultRetention).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps Mistral prompt cache keys without unsupported long retention", () => {
    const model = {
      id: "mistral-large-latest",
      name: "Mistral Large",
      api: "openai-completions",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
      compat: {
        supportsPromptCacheKey: true,
        supportsLongCacheRetention: false,
        supportsStore: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
      },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    } as unknown as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const params = buildOpenAICompletionsParams(model, context, {
      sessionId: "session-123",
      cacheRetention: "long",
    }) as { prompt_cache_key?: string; prompt_cache_retention?: string };

    expect(params.prompt_cache_key).toBe("session-123");
    expect(params).not.toHaveProperty("prompt_cache_retention");
  });

  it("sorts Chat Completions tools by function name for stable prompt-cache payloads", () => {
    const model = promptCacheModel();
    const zetaTool = {
      name: "zeta",
      description: "Z",
      parameters: { type: "object", properties: {} },
    };
    const alphaTool = {
      name: "alpha",
      description: "A",
      parameters: { type: "object", properties: {} },
    };

    const first = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [zetaTool, alphaTool],
      } as never,
      { sessionId: "session-123" },
    ) as { tools?: Array<{ function?: { name?: string } }> };
    const second = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [alphaTool, zetaTool],
      } as never,
      { sessionId: "session-123" },
    ) as { tools?: Array<{ function?: { name?: string } }> };

    expect(first.tools?.map((tool) => tool.function?.name)).toEqual(["alpha", "zeta"]);
    expect(first.tools).toEqual(second.tools);
  });

  it("disables developer-role-only compat defaults for configured custom proxy completions providers", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "custom-model",
        name: "Custom Model",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
      }),
      lookupWeatherContext(),
      {
        reasoningEffort: "high",
      } as never,
    ) as {
      messages?: Array<{ role?: string }>;
      reasoning_effort?: unknown;
      stream_options?: unknown;
      store?: unknown;
      tools?: Array<{ function?: { strict?: boolean } }>;
    };

    expect(params.messages?.[0]?.role).toBe("system");
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("store");
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("flattens pure text content arrays for string-only completions backends when opted in", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "google/gemma-4-E2B-it",
        name: "Gemma 4 E2B",
        provider: "inferrs",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: false,
        contextWindow: 131072,
        maxTokens: 4096,
        compat: {
          requiresStringContent: true,
        } as Record<string, unknown>,
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What is 2 + 2?" }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ role?: string; content?: unknown }> };

    expect(params.messages?.[0]).toEqual({ role: "system", content: "system" });
    expect(params.messages?.[1]).toEqual({ role: "user", content: "What is 2 + 2?" });
  });

  it("strips extra message keys for strict-key completions backends when opted in", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mistral3",
        name: "mistral3",
        provider: "infomaniak",
        baseUrl: "https://api.infomaniak.com/1/ai/example/openai",
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
        compat: {
          strictMessageKeys: true,
        } as Record<string, unknown>,
      }),
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "noop",
                arguments: {},
              },
            ],
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "text", text: "tool result" }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<Record<string, unknown>> };

    expect(params.messages?.[0]).toEqual({ role: "assistant", content: null });
    expect(params.messages?.[1]).toEqual({ role: "tool", content: "tool result" });
  });

  it("uses max_tokens for Chutes default-route completions providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
      } as never,
    );

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("uses model maxTokens for OpenAI completions params when runtime maxTokens is omitted", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        maxTokens: 65_536,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("omits output-token fields when the resolved model has no known cap", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        api: "openai-completions",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
      } as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("max_tokens");
  });
});
