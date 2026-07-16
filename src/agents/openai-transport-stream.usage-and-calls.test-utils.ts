// Imported by openai-transport-stream.test.ts to keep its mocked suite in one Vitest module graph.
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  makeCompletionsModel,
  makeResponsesModel,
  makeCompletionsChunk,
  createAssistantOutput,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("openai transport stream", () => {
  it("uses model params max_completion_tokens for OpenAI completions before model maxTokens", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps runtime maxTokens ahead of model params max_completion_tokens for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { maxTokens: 16_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(16_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("clamps runtime maxTokens to the OpenAI completions model output cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        provider: "xiaomi-token-plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        maxTokens: 32_000,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { maxTokens: 200_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(32_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps zero runtime maxTokens falling back to model params for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      { maxTokens: 0 } as never,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("uses model maxTokens with max_tokens completions compat when runtime maxTokens is omitted", () => {
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
        maxTokens: 65_536,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("clamps max_completion_tokens to the remaining context budget for proxy-like endpoints when prompt + output would exceed contextWindow (covers #83086)", () => {
    // StepFun-style shape: large context window, max_tokens equal to context,
    // and a substantial prompt that should leave well under the context budget.
    // 200_000 ASCII chars -> estimated 62_500 input tokens (chars/4 * 1.25).
    // That leaves remaining budget of 262_144 - 62_500 - 1 = 199_643 tokens.
    const systemPrompt = "x".repeat(200_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "step-router-v1",
        name: "StepFun step-router-v1",
        provider: "stepfun-plan",
        baseUrl: "https://api.stepfun.com/v1",
        reasoning: false,
        contextWindow: 262_144,
        maxTokens: 262_144,
      }),
      {
        systemPrompt,
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    const estimatedInputTokens = Math.ceil((systemPrompt.length / 4) * 1.25);
    expect(cap).toBe(262_144 - estimatedInputTokens - 1);
    expect(cap).toBeLessThan(262_144);
  });

  it("uses CJK-aware input estimates when clamping proxy-like completions output budgets", () => {
    const cjkPrompt = "你好世界".repeat(1_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: cjkPrompt,
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    // 4,000 CJK chars count as 16,000 adjusted chars, then chars/4 * 1.25.
    expect(params.max_completion_tokens).toBe(10_000 - 5_000 - 1);
  });

  it("rounds proxy-like completions input estimates after summing message content", () => {
    const messages = Array.from({ length: 4_000 }, () => ({
      role: "user",
      content: "x",
    }));
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: undefined,
        messages,
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(10_000 - 1_250 - 1);
  });

  it("estimates proxy-like completions input from the final outbound messages after compat transforms", () => {
    const userText = "ok";
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        messages: [
          { role: "user", content: userText, timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(20_000) }],
            api: "openai-completions",
            provider: "vllm",
            model: "qwen3-5-122b-a10b-nvfp4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "aborted",
            timestamp: 2,
          },
        ],
        tools: [],
      } as never,
      undefined,
    );

    const estimatedInputTokens = Math.ceil((userText.length / 4) * 1.25);
    expect(params.max_completion_tokens).toBe(10_000 - estimatedInputTokens - 1);
  });

  it("clamps proxy-like completions output budgets against contextTokens before contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        api: "openai-completions",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        contextTokens: 4_096,
        maxTokens: 200_000,
      } as unknown as Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(4_096 - 2 - 1);
  });

  it("clamps max_completion_tokens for proxy-like endpoints when configured maxTokens >= contextWindow and prompt is small", () => {
    // Misconfig case: tiny prompt, but configured maxTokens still exceeds the
    // model's contextWindow. Clamp should land just under the window.
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
        maxTokens: 200_000,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    expect(cap).toBeLessThan(131_072);
    // Small prompt → cap is essentially contextWindow - 1 - tiny_input_estimate.
    expect(cap).toBeGreaterThanOrEqual(131_000);
  });

  it("does not clamp max_completion_tokens for proxy-like endpoints when maxTokens fits the context window", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(8192);
  });

  it("preserves the configured maxTokens for native openai-completions endpoints even when it equals or exceeds contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 200_000,
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(200_000);
  });

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

  describe("Gemini thought_signature round-trip on OpenAI-compatible completions", () => {
    const geminiModel = makeCompletionsModel({
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      contextWindow: 1_000_000,
    });

    function makeAssistantOutput(model: Model<"openai-completions">) {
      return {
        role: "assistant" as const,
        content: [] as Array<Record<string, unknown>>,
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

    it("captures thought_signature from streamed Google tool_calls", async () => {
      const output = makeAssistantOutput(geminiModel);
      const chunks = [
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "echo_value", arguments: "" },
              extra_content: { google: { thought_signature: "SIG-OPAQUE-ABC==" } },
            },
          ],
        }),
        makeCompletionsChunk(
          {
            tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }],
          },
          "tool_calls" as const,
        ),
      ] as const;
      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk as never;
        }
      }

      await testing.processOpenAICompletionsStream(mockStream(), output, geminiModel, {
        push() {},
      });

      expectRecordFields(output.content[0], {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: { value: "repro" },
        thoughtSignature: "SIG-OPAQUE-ABC==",
      });
    });

    it("re-emits captured thought_signature for same Google route tool-call replay", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            { role: "user", content: "echo" },
            {
              role: "assistant",
              api: geminiModel.api,
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature: "SIG-OPAQUE-ABC==",
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_abc",
              toolName: "echo_value",
              content: [{ type: "text", text: "ok" }],
              isError: false,
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "SIG-OPAQUE-ABC==",
      );
    });

    it("uses the Gemini skip-validator signature across a different API surface", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            {
              role: "assistant",
              api: "google-generative-ai",
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature: "SIG-OPAQUE-ABC==",
                },
              ],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("uses the Gemini skip-validator signature when no thought_signature was captured", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            {
              role: "assistant",
              api: geminiModel.api,
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [{ type: "toolCall", id: "call_abc", name: "echo_value", arguments: {} }],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("falls back to skip_thought_signature_validator when a captured same-route Gemini 3 signature is truncated", () => {
      // Compaction-truncated sig: 109 chars, length mod 4 == 1.
      // Same-route assistant tool-call whose captured thoughtSignature is truncated.
      // The guard should fall back to the sentinel instead of dropping the field.
      const params = buildOpenAICompletionsParams(
        geminiModel,
        {
          messages: [
            {
              role: "assistant",
              api: geminiModel.api,
              provider: geminiModel.provider,
              model: geminiModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature:
                    "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC",
                },
              ],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("drops the field when the model is not Gemini 3 and the captured same-route signature is truncated", () => {
      // gemini-2.5-pro: requiresGoogleCompatToolCallThoughtSignature returns false,
      // so fallbackSig is undefined and there is no sentinel to fall back to.
      // A truncated same-route sig should cause the field to be dropped entirely.
      const nonGemini3Model = {
        ...geminiModel,
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
      };
      const params = buildOpenAICompletionsParams(
        nonGemini3Model,
        {
          messages: [
            {
              role: "assistant",
              api: nonGemini3Model.api,
              provider: nonGemini3Model.provider,
              model: nonGemini3Model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature:
                    "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC",
                },
              ],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBeUndefined();
    });

    it("does not trust cross-route thought_signature for non-Gemini-3 Google compat models", () => {
      const nonGemini3Model = {
        ...geminiModel,
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
      };
      const params = buildOpenAICompletionsParams(
        nonGemini3Model,
        {
          messages: [
            {
              role: "assistant",
              api: "google-generative-ai",
              provider: nonGemini3Model.provider,
              model: nonGemini3Model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 1,
              content: [
                {
                  type: "toolCall",
                  id: "call_abc",
                  name: "echo_value",
                  arguments: { value: "repro" },
                  thoughtSignature: "SIG-OPAQUE-ABC==",
                },
              ],
            },
          ],
          tools: [],
        } as never,
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: unknown }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content).toBeUndefined();
    });

    it.each([
      ["gemini-pro-latest", "Gemini Pro Latest"],
      ["gemini-flash-latest", "Gemini Flash Latest"],
      ["gemini-flash-lite-latest", "Gemini Flash Lite Latest"],
    ])(
      "uses the Gemini skip-validator signature for unsigned tool calls on %s",
      (modelId, modelName) => {
        const latestModel = { ...geminiModel, id: modelId, name: modelName };
        const params = buildOpenAICompletionsParams(
          latestModel,
          {
            messages: [
              {
                role: "assistant",
                api: latestModel.api,
                provider: latestModel.provider,
                model: latestModel.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 1,
                content: [{ type: "toolCall", id: "call_abc", name: "echo_value", arguments: {} }],
              },
            ],
            tools: [],
          } as never,
          undefined,
        ) as { messages: Array<Record<string, unknown>> };

        const assistant = params.messages.find((message) => message.role === "assistant") as
          | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
          | undefined;
        expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
          "skip_thought_signature_validator",
        );
      },
    );
  });

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
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
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
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
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

  it("serializes raw string tool-call arguments without double-encoding them", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
            content: [
              {
                type: "toolCall",
                id: "call_abc|fc_item1",
                name: "my_tool",
                arguments: "not valid json",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ type?: string; arguments?: string }>;
    };

    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      arguments: "not valid json",
    });
  });

  it("defaults tool_choice to auto for proxy-like openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "test-model",
        name: "Test Model",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "auto");
  });

  it("does not send tool_choice by default for native openai-completions endpoints", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("sends tool_choice when explicitly configured", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "test-model",
        name: "Test Model",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [
          {
            name: "get_weather",
            description: "Get weather information",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      {
        toolChoice: "required",
      },
    );

    expect(params).toHaveProperty("tools");
    expect(params).toHaveProperty("tool_choice", "required");
  });

  it("omits empty tools and tool_choice for proxy-like openai-completions endpoints when context.tools is []", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "test-model",
        name: "Test Model",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("omits tools for proxy-like openai-completions endpoints when only prior tool history is present", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "test-model",
        name: "Test Model",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
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
      } as never,
      undefined,
    );

    expect(params).not.toHaveProperty("tools");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("preserves empty tools array for native openai-completions endpoints (existing behavior)", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect((params as { tools: unknown[] }).tools).toEqual([]);
  });

  it("preserves tools: [] fallback for native openai-completions endpoints when only prior tool history is present (existing behavior)", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 2048,
      }),
      {
        systemPrompt: "You are a helpful assistant",
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
      } as never,
      undefined,
    );

    expect(params).toHaveProperty("tools");
    expect((params as { tools: unknown[] }).tools).toEqual([]);
  });

  it("resets stopReason to stop when finish_reason is tool_calls but tool_calls array is empty", async () => {
    const model = makeCompletionsModel({
      id: "nemotron-3-super",
      name: "Nemotron 3 Super",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 1000000,
    });

    const output = {
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

    const stream = {
      push: () => {},
    };

    const mockChunks = [
      makeCompletionsChunk({ role: "assistant" as const, content: "" }),
      makeCompletionsChunk({ content: "4" }),
      makeCompletionsChunk({ tool_calls: [] as never[] }, "tool_calls" as const),
    ] as const;

    async function* mockStream() {
      for (const chunk of mockChunks) {
        yield chunk as never;
      }
    }

    await testing.processOpenAICompletionsStream(mockStream(), output, model, stream);

    expect(output.stopReason).toBe("stop");
    expect(
      output.content.filter((block) => (block as { type?: string }).type === "toolCall"),
    ).toStrictEqual([]);
  });

  it("accumulates arguments for parallel tool calls with split indices", async () => {
    const model = makeCompletionsModel({
      id: "kimi-for-coding",
      name: "Kimi for Coding",
      provider: "kimi-code",
      baseUrl: "https://api.moonshot.cn",
    });

    const output = createAssistantOutput(model);

    const mockChunks = [
      makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_0",
            type: "function",
            function: { name: "exec", arguments: "" },
          },
          {
            index: 1,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      }),
      makeCompletionsChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }],
      }),
      makeCompletionsChunk(
        {
          tool_calls: [{ index: 1, function: { arguments: '{"path":"/tmp"}' } }],
        },
        "tool_calls" as const,
      ),
    ] as const;

    await testing.processOpenAICompletionsStream(streamChunks(mockChunks), output, model, {
      push() {},
    });

    expect(output.content).toHaveLength(2);
    expectRecordFields(output.content[0], {
      type: "toolCall",
      id: "call_0",
      name: "exec",
      arguments: { command: "ls" },
    });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "/tmp" },
    });
  });

  it("keeps buffered visible text before following tool calls", async () => {
    const model = makeCompletionsModel({
      id: "plain-openai-compatible",
      name: "Plain OpenAI Compatible",
      provider: "plain-openai-compatible",
      baseUrl: "https://api.compat.test/v1",
      reasoning: false,
    });
    const output = createAssistantOutput(model);

    await testing.processOpenAICompletionsStream(
      streamChunks([
        makeCompletionsChunk({ content: "Use <" }),
        makeCompletionsChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "exec", arguments: '{"command":"ls"}' },
              },
            ],
          },
          "tool_calls" as const,
        ),
      ]),
      output,
      model,
      { push() {} },
    );

    expect(output.content[0]).toEqual({ type: "text", text: "Use <" });
    expectRecordFields(output.content[1], {
      type: "toolCall",
      id: "call_0",
      name: "exec",
      arguments: { command: "ls" },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
