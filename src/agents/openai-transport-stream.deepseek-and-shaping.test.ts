import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  createAzureResponsesModel,
  expectRecordFields,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("openai transport stream", () => {
  it("carries the system prompt via top-level instructions for xAI responses providers", () => {
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
    ) as { instructions?: string };

    expect(params.instructions).toBe("system");
  });

  it("adds explicit message item types for Responses user input items, carrying the system prompt via instructions", () => {
    const params = buildOpenAIResponsesParams(
      // Azure is not verified for instructions by default (unlike native
      // OpenAI/xAI); this test is about message-item-type structure once
      // instructions is in play, so opt in explicitly. `compat` types to
      // `never` for this API variant (no recognized branch in Model<TApi>).
      { ...createAzureResponsesModel(), compat: { supportsInstructions: true } } as never,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      } as never,
      undefined,
    ) as {
      instructions?: string;
      input?: Array<{ type?: string; role?: string; content?: unknown }>;
    };

    expect(params.instructions).toBe("system");
    expect(params.input?.[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  it("omits Responses reasoning params when model compat disables reasoning effort", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 0309 (Reasoning)",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 30_000,
        compat: { supportsReasoningEffort: false },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("preserves xAI Grok 4.3 default reasoning by omitting default none", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
        },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("passes explicit xAI Grok 4.3 reasoning effort through", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
        },
      } as unknown as Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("carries the system prompt via top-level instructions for native OpenAI reasoning responses models", () => {
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
      undefined,
    ) as { instructions?: string };

    expect(params.instructions).toBe("system");
  });

  it("serializes Responses input messages with explicit message type and content parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
        // Azure is not verified for instructions by default; this test is
        // about message serialization structure once instructions is in
        // play, so opt in explicitly.
        compat: { supportsInstructions: true },
      }),
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      } as never,
      undefined,
    ) as { instructions?: string; input?: unknown };

    expect(params.instructions).toBe("system");
    expect(params.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  it("uses model maxTokens for Responses params when runtime maxTokens is omitted", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
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
    ) as { max_output_tokens?: unknown };

    expect(params.max_output_tokens).toBe(65_536);
  });

  it("prefers promptCacheKey over sessionId for Responses prompt-cache affinity", () => {
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
      {
        sessionId: "run-session",
        promptCacheKey: "cron-cache-key",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("cron-cache-key");
  });

  it("clamps Responses promptCacheKey before sending it upstream", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        promptCacheKey: "x".repeat(80),
        sessionId: "session-123",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("x".repeat(64));
  });

  it("omits Responses prompt_cache_key when caching is disabled", () => {
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
      {
        sessionId: "run-session",
        promptCacheKey: "cron-cache-key",
        cacheRetention: "none",
      },
    ) as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBeUndefined();
  });

  it("adds fallback instructions for raw native Codex responses probes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
        tools: [],
      } as never,
      {
        maxTokens: 16,
        sessionId: "session-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Follow the user request.");
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.prompt_cache_retention).toBeUndefined();
  });

  it("does not add fallback instructions for custom Codex-compatible responses backends", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
        contextWindow: 400000,
        maxTokens: 128000,
      }),
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
        tools: [],
      } as never,
      {
        maxTokens: 16,
        sessionId: "session-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBeUndefined();
    expect(params.max_output_tokens).toBe(16);
  });

  it("uses top-level instructions for Codex responses and preserves prompt cache identity", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(Array.isArray(params.input)).toBe(true);
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expect(
      params.input?.filter((item) => item.role === "system" || item.role === "developer"),
    ).toStrictEqual([]);
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("keeps Codex response shaping when simple completions use the OpenClaw transport alias", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openclaw-openai-chatgpt-responses-transport" as Api,
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("sanitizes Codex responses params after payload hooks mutate them without stripping cache identity", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
      text: { format: { type: "json_object" }, verbosity: "low" },
      top_p: 0.85,
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      payload,
    );

    expect(sanitized.prompt_cache_key).toBe("session-123");
    expect(sanitized).not.toHaveProperty("metadata");
    expect(sanitized).not.toHaveProperty("max_output_tokens");
    expect(sanitized).not.toHaveProperty("prompt_cache_retention");
    expect(sanitized).not.toHaveProperty("service_tier");
    expect(sanitized).not.toHaveProperty("temperature");
    expect(sanitized.text).toEqual({ verbosity: "low" });
    expect(sanitized).not.toHaveProperty("top_p");
  });

  it("preserves custom Codex-compatible responses params", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
        // Unrecognized custom base URL: instructions default off unless
        // verified. This fixture is specifically testing param preservation
        // once instructions is in play, so opt in explicitly. `compat` types
        // to `never` for this API variant (no recognized branch in
        // Model<TApi>), matching the sibling `as never` casts in this file.
        compat: { supportsInstructions: true },
      } as never),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.metadata).toEqual({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
    });
    expect(params.max_output_tokens).toBe(1024);
    expect(params.temperature).toBe(0.2);
    expect(params.top_p).toBe(0.85);
  });

  it("forwards response_format to responses text format request params", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      maxTokens: 65_536,
    });

    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [],
    } as never;

    {
      const params = buildOpenAIResponsesParams(model, context, {
        responseFormat: { type: "json_object" },
      }) as Record<string, unknown>;
      expect(params.text).toEqual({ format: { type: "json_object" } });
    }

    {
      const params = buildOpenAIResponsesParams(model, context, {
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "test", schema: { type: "object" } },
        },
      }) as Record<string, unknown>;
      expect(params.text).toEqual({
        format: { type: "json_schema", name: "test", schema: { type: "object" } },
      });
    }

    {
      const params = buildOpenAIResponsesParams(model, context, {}) as Record<string, unknown>;
      expect(params).not.toHaveProperty("text");
    }
  });

  it("preserves custom Codex-compatible responses params after payload hooks mutate them", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
      }),
      payload,
    );

    expect(sanitized).toEqual(payload);
  });

  it("omits native Codex replay item ids and unproven encrypted reasoning", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
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
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
          { role: "user", content: "what is the capital of the philippines", timestamp: 3 },
        ],
        tools: [],
      } as never,
      { sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
  });
});
