// Imported by openai-transport-stream.test.ts to keep its mocked suite in one Vitest module graph.
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  makeCompletionsModel,
  makeResponsesModel,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";

describe("openai transport stream", () => {
  it("omits responses strict tool shaping for proxy-like OpenAI routes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
  });

  it("keeps native responses strict mode for projected tools after dropping bad schemas", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "broken",
            description: "Broken",
            parameters: {
              type: "object",
              get properties(): never {
                throw new Error("properties exploded");
              },
            },
          },
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: {},
          },
        ],
      } as never,
      undefined,
    ) as {
      tools?: Array<{
        name?: string;
        strict?: boolean;
        parameters?: Record<string, unknown>;
      }>;
    };

    expect(params.tools).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("still normalizes responses tool parameters when strict is omitted", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: {},
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]).not.toHaveProperty("strict");
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: {},
    });
  });

  it("normalizes responses tool parameters while downgrading native strict:false", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }> };

    expect(params.tools?.[0]?.strict).toBe(false);
    expectRecordFields(params.tools?.[0]?.parameters, {
      type: "object",
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("adds native OpenAI turn metadata on direct Responses routes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123" } as never,
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
        openclaw_turn_attempt: "1",
        openclaw_transport: "stream",
      },
    ) as { metadata?: Record<string, string> };

    expectRecordFields(params.metadata, {
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
      openclaw_turn_attempt: "1",
      openclaw_transport: "stream",
    });
  });

  it("leaves proxy-like OpenAI Responses routes without native turn metadata by default", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123" } as never,
      undefined,
    ) as { metadata?: Record<string, string> };

    expect(params).not.toHaveProperty("metadata");
  });

  it("gates responses service_tier to native OpenAI endpoints", () => {
    const nativeParams = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };
    const proxyParams = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "custom-model",
        name: "Custom Model",
        baseUrl: "https://proxy.example.com/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };

    expect(nativeParams.service_tier).toBe("priority");
    expect(proxyParams).not.toHaveProperty("service_tier");
  });

  it("strips store when responses compat disables it", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "custom-provider",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
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
      undefined,
    ) as { store?: unknown };

    expect(params).not.toHaveProperty("store");
  });

  it("uses system role for xAI default-route responses providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]?.role).toBe("system");
  });

  it("uses system role for Moonshot default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        api: "openai-completions",
        provider: "moonshot",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ role?: string }> };

    expect(params.messages?.[0]?.role).toBe("system");
  });

  it("strips the internal cache boundary from OpenAI completions system prompts", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-4.1",
        name: "GPT-4.1",
        reasoning: false,
      }),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ content?: string }> };

    expect(params.messages?.[0]?.content).toBe("Stable prefix\nDynamic suffix");
  });

  it("uses shared stream reasoning as OpenAI completions effort", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("medium");
  });

  it("maps minimal shared reasoning to low for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("low");
  });

  it("defaults OpenAI completions reasoning effort to high when unset", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("high");
  });

  it.each([
    {
      label: "omits reasoning_effort for gpt-5.4-mini Chat Completions tool payloads",
      model: {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400000,
        maxTokens: 128000,
      },
      reasoning: "medium",
      expectedEffort: undefined,
      assertToolShape: true,
    },
    ...[
      ["implicit default", ""],
      ["default", "https://api.openai.com/v1"],
    ].map(([route, baseUrl]) => ({
      label: `omits reasoning_effort for OpenAI ${route} gpt-5.5 Chat Completions tool payloads`,
      model: {
        id: "gpt-5.5",
        name: "GPT-5.5",
        baseUrl,
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      reasoning: "medium",
      expectedEffort: undefined,
      assertToolShape: false,
    })),
    {
      label: "disables reasoning for OpenAI gpt-5.6 Chat Completions tool payloads",
      model: {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      reasoning: "low",
      expectedEffort: "none",
      assertToolShape: false,
    },
    {
      label: "keeps reasoning_effort for custom gpt-5.5 Chat Completions tool payloads",
      model: {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "custom-openai",
        baseUrl: "https://models.example.com/v1",
        compat: { supportsReasoningEffort: true },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      reasoning: "medium",
      expectedEffort: "medium",
      assertToolShape: false,
    },
  ])("$label", ({ model, reasoning, expectedEffort, assertToolShape }) => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel(model),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning,
      } as never,
    ) as { reasoning_effort?: unknown; tools?: unknown };

    expect(params.tools).toHaveLength(1);
    if (assertToolShape) {
      const tool = expectDefined(
        (params.tools as Array<Record<string, unknown>>)[0],
        "(params.tools as Array<Record<string, unknown>>)[0] test invariant",
      );
      expectRecordFields(tool, { type: "function" });
      expectRecordFields(tool.function, { name: "lookup_weather" });
    }
    if (expectedEffort === undefined) {
      expect(params).not.toHaveProperty("reasoning_effort");
    } else {
      expect(params.reasoning_effort).toBe(expectedEffort);
    }
  });

  it.each([
    ["Azure OpenAI", "https://example.openai.azure.com/openai/v1"],
    ["Foundry", "https://example.services.ai.azure.com/openai/v1"],
    ["Cognitive Services", "https://example.cognitiveservices.azure.com/openai/v1"],
  ])(
    "omits reasoning_effort for %s gpt-5.5 deployment aliases with tool payloads",
    (_label, baseUrl) => {
      const params = buildOpenAICompletionsParams(
        makeCompletionsModel({
          id: "prod-spud",
          name: "GPT-5.5 (Azure)",
          provider: "azure-openai",
          baseUrl,
          contextWindow: 1000000,
          maxTokens: 128000,
        }),
        {
          systemPrompt: "system",
          messages: [],
          tools: [
            {
              name: "lookup_weather",
              description: "Get forecast",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        } as never,
        {
          reasoning: "medium",
        } as never,
      ) as { reasoning_effort?: unknown; tools?: unknown };

      expect(params.tools).toHaveLength(1);
      expect(params).not.toHaveProperty("reasoning_effort");
    },
  );

  it("keeps reasoning_effort for gpt-5.5 Chat Completions payloads without tools", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 1000000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown; tools?: unknown };

    expect(params.tools).toHaveLength(0);
    expect(params.reasoning_effort).toBe("medium");
  });

  it("keeps reasoning_effort for gpt-5.4-mini Chat Completions payloads without tools", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "medium",
      } as never,
    ) as { reasoning_effort?: unknown; tools?: unknown };

    expect(params.tools).toStrictEqual([]);
    expect(params.reasoning_effort).toBe("medium");
  });

  it("uses provider-native reasoning effort values declared by model compat", () => {
    const baseModel = {
      id: "qwen/qwen3-32b",
      name: "Qwen 3 32B",
      api: "openai-completions",
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "default"],
        reasoningEffortMap: {
          off: "none",
          low: "default",
          medium: "default",
          high: "default",
        },
      },
    } as unknown as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const enabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "medium",
    } as never) as { reasoning_effort?: unknown };
    const disabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "off",
    } as never) as { reasoning_effort?: unknown };

    expect(enabled.reasoning_effort).toBe("default");
    expect(disabled.reasoning_effort).toBe("none");
  });

  it("maps qwen thinking format to top-level enable_thinking", () => {
    const baseModel = {
      id: "qwen3.5-32b",
      name: "Qwen 3.5 32B",
      api: "openai-completions",
      provider: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {
        thinkingFormat: "qwen",
      },
    } as unknown as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const enabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "medium",
    } as never) as { enable_thinking?: unknown; reasoning_effort?: unknown };
    const disabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "off",
    } as never) as { enable_thinking?: unknown; reasoning_effort?: unknown };

    expect(enabled.enable_thinking).toBe(true);
    expect(disabled.enable_thinking).toBe(false);
    expect(enabled).not.toHaveProperty("reasoning_effort");
    expect(disabled).not.toHaveProperty("reasoning_effort");
  });

  it("maps qwen-chat-template thinking format to chat_template_kwargs", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3.5-32b",
        name: "Qwen 3.5 32B",
        api: "openai-completions",
        provider: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        compat: {
          thinkingFormat: "qwen-chat-template",
        },
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "off",
      } as never,
    ) as { chat_template_kwargs?: Record<string, unknown>; reasoning_effort?: unknown };

    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("maps together thinking format to reasoning enabled", () => {
    const baseModel = {
      id: "moonshotai/Kimi-K2.5",
      name: "Kimi K2.5",
      api: "openai-completions",
      provider: "together",
      baseUrl: "https://api.together.xyz/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
      compat: {
        thinkingFormat: "together",
        supportsReasoningEffort: true,
      },
    } as unknown as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const enabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "medium",
    } as never) as {
      max_completion_tokens?: unknown;
      max_tokens?: unknown;
      reasoning?: unknown;
      reasoning_effort?: unknown;
    };
    const disabled = buildOpenAICompletionsParams(baseModel, context, {
      reasoning: "off",
    } as never) as { reasoning?: unknown; reasoning_effort?: unknown };

    expect(enabled.max_tokens).toBe(32768);
    expect(enabled).not.toHaveProperty("max_completion_tokens");
    expect(enabled.reasoning).toEqual({ enabled: true });
    expect(enabled.reasoning_effort).toBe("medium");
    expect(disabled.reasoning).toEqual({ enabled: false });
    expect(disabled).not.toHaveProperty("reasoning_effort");
  });

  it("omits unsupported disabled reasoning for completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        api: "openai-completions",
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "off",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses system role and streaming usage compat for native Qwen completions providers", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        provider: "qwen",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        compat: { supportsUsageInStreaming: true },
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
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
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
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
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
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
    const params = buildOpenAICompletionsParams(
      {
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
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { sessionId: "session-123", promptCacheKey: "cron-cache-key" },
    ) as { prompt_cache_key?: string };

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
    const model = {
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
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

    const longRetention = buildOpenAICompletionsParams(model, context, {
      sessionId: "session-123",
      cacheRetention: "long",
    }) as { prompt_cache_key?: string; prompt_cache_retention?: string };

    expect(longRetention.prompt_cache_key).toBe("session-123");
    expect(longRetention.prompt_cache_retention).toBe("24h");
  });

  it("omits prompt_cache_retention for completions when cacheRetention is short or unset", () => {
    const model = {
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
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as never;

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
    const model = {
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
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
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
