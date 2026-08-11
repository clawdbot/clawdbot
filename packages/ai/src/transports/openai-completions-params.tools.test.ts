import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

describe("openai completions params", () => {
  it("omits strict tool shaping for Z.ai default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "glm-5",
        name: "GLM 5",
        provider: "zai",
        baseUrl: "",
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
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("defaults completions tool schemas to strict on native OpenAI routes", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5",
        name: "GPT-5",
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
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function?.strict).toBe(true);
  });

  it("keeps native completions strict mode for projected tools after dropping bad schemas", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5",
        name: "GPT-5",
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
        function?: {
          name?: string;
          strict?: boolean;
          parameters?: Record<string, unknown>;
        };
      }>;
    };

    expect(params.tools?.map((tool) => tool.function)).toEqual([
      {
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

  it("falls back to completions strict:false when a native OpenAI tool schema is not strict-compatible", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5",
        name: "GPT-5",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function?.strict).toBe(false);
  });

  it("applies model compat unsupported schema keywords to completions tools", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "accounts/fireworks/routers/kimi-k2p5-turbo",
        name: "Kimi K2.5 Turbo",
        provider: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        reasoning: false,
        contextWindow: 256000,
        maxTokens: 256000,
        compat: {
          unsupportedToolSchemaKeywords: ["not"],
        } as never,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: {
              type: "object",
              properties: {
                forbidden: { not: {} },
              },
            },
          },
        ],
      } as never,
      undefined,
    ) as {
      tools?: Array<{ function?: { parameters?: { properties?: Record<string, unknown> } } }>;
    };

    expect(params.tools?.[0]?.function?.parameters?.properties?.forbidden).toStrictEqual({});
  });

  it("applies model compat empty array items omission after completions normalization", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mimo-v2.5",
        name: "MiMo V2.5",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        contextWindow: 256000,
        maxTokens: 256000,
        compat: {
          omitEmptyArrayItems: true,
        } as never,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "collect",
            description: "Collect hints",
            parameters: {
              type: "object",
              properties: {
                hints: { type: "array" },
                typedHints: { type: "array", items: { type: "string" } },
              },
            },
          },
        ],
      } as never,
      undefined,
    ) as {
      tools?: Array<{ function?: { parameters?: { properties?: Record<string, unknown> } } }>;
    };

    expect(params.tools?.[0]?.function?.parameters?.properties?.hints).toStrictEqual({
      type: "array",
    });
    expect(params.tools?.[0]?.function?.parameters?.properties?.typedHints).toStrictEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("omits tools from completions payload when model compat sets supportsTools to false", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "chat-only-model",
        name: "Chat Only Model",
        provider: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
        compat: {
          supportsTools: false,
        } as Record<string, unknown>,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "noop",
            description: "noop tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: unknown; tool_choice?: unknown };

    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("omits tool-history tools:[] fallback when model compat sets supportsTools to false", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "chat-only-model",
        name: "Chat Only Model",
        provider: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
        compat: {
          supportsTools: false,
        } as Record<string, unknown>,
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_abc",
                name: "noop",
                arguments: {},
              },
            ],
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "call_abc",
            toolName: "noop",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      } as never,
      undefined,
    ) as { tools?: unknown };

    expect(params).not.toHaveProperty("tools");
  });

  it("fails locally when required Chat Completions has no usable tools", () => {
    expect(() =>
      buildOpenAICompletionsParams(
        makeCompletionsModel({
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: false,
        }),
        {
          systemPrompt: "system",
          messages: [],
          tools: [
            {
              name: "broken",
              get parameters(): never {
                throw new Error("parameters exploded");
              },
            },
          ],
        } as never,
        { toolChoice: "required" },
      ),
    ).toThrow("no tools survived schema conversion");
  });

  it("preserves the native empty tools marker for tool history after quarantining every schema", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: false,
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_abc",
                name: "lookup",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "done" }],
            toolCallId: "call_abc",
          },
          { role: "user", content: "continue", timestamp: 1 },
        ],
        tools: [
          {
            name: "broken",
            description: "Broken tool.",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: unknown[] };

    expect(params.tools).toEqual([]);
  });
});
