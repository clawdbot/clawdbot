import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { expectRecordFields, makeCompletionsModel } from "./openai-completions.test-support.js";

function emptyContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

describe("openai completions params", () => {
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
      emptyContext(),
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
      emptyContext(),
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
      emptyContext(),
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
      emptyContext(),
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
      emptyContext(),
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
      emptyContext(),
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

  it("preserves map-only canonical effort mappings in Completions payloads", () => {
    const model = {
      id: "custom-reasoning",
      name: "Custom Reasoning",
      api: "openai-completions",
      provider: "custom-openai-compatible",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        reasoningEffortMap: { high: "xhigh" },
      },
    } as unknown as Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, emptyContext(), {
      reasoning: "high",
    } as never) as { reasoning_effort?: unknown };

    expect(params.reasoning_effort).toBe("xhigh");
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
      emptyContext(),
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
      emptyContext(),
      {
        reasoning: "off",
      } as never,
    ) as { reasoning_effort?: unknown };

    expect(params).not.toHaveProperty("reasoning_effort");
  });
});
