import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat } from "../types.js";

const mockOpenAI = vi.hoisted(() => ({
  chunks: [] as unknown[],
  clientOptions: [] as unknown[],
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  nextError: undefined as Error | undefined,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: unknown) {
      mockOpenAI.clientOptions.push(options);
    }

    chat = {
      completions: {
        create: (payload: unknown, requestOptions: unknown) => {
          mockOpenAI.payloads.push(payload);
          mockOpenAI.requestOptions.push(requestOptions);
          return {
            withResponse: async () => {
              if (mockOpenAI.nextError !== undefined) {
                throw mockOpenAI.nextError;
              }
              async function* stream() {
                yield* mockOpenAI.chunks;
              }
              return {
                data: stream(),
                response: { status: 200, headers: new Headers() },
              };
            },
          };
        },
      },
    };
  }

  return { default: MockOpenAI };
});

import { streamOpenAICompletions } from "./openai-completions.js";

const baseModel: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const userMessage = { role: "user", content: "hello", timestamp: 1 } as const;
const context: Context = { messages: [userMessage] };

function createModel(
  overrides: Partial<Model<"openai-completions">> & {
    compat?: OpenAICompletionsCompat;
  } = {},
): Model<"openai-completions"> {
  return { ...baseModel, ...overrides };
}

function chunk(delta: Record<string, unknown>, finishReason?: string): unknown {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

beforeEach(() => {
  mockOpenAI.chunks = [chunk({ content: "ok" }), chunk({}, "stop")];
  mockOpenAI.clientOptions = [];
  mockOpenAI.payloads = [];
  mockOpenAI.requestOptions = [];
  mockOpenAI.nextError = undefined;
});

describe("OpenAI-compatible completions compatibility", () => {
  it("buffers encrypted reasoning details until their tool call arrives", async () => {
    const reasoningDetail = {
      type: "reasoning.encrypted",
      id: "call_1",
      data: "encrypted-signature",
    };
    mockOpenAI.chunks = [
      chunk({ reasoning_details: [reasoningDetail] }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ];
    const model = createModel({
      id: "google/gemini-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    });

    const result = await streamOpenAICompletions(model, context, {
      apiKey: "test",
    }).result();

    expect(result.content.find((block) => block.type === "toolCall")).toMatchObject({
      id: "call_1",
      thoughtSignature: JSON.stringify(reasoningDetail),
    });

    let replayPayload: unknown;
    await streamOpenAICompletions(
      model,
      { messages: [result] },
      {
        apiKey: "test",
        onPayload(payload) {
          replayPayload = payload;
          throw new Error("payload captured");
        },
      },
    ).result();
    const replayedAssistant = (
      replayPayload as { messages?: Array<{ role?: string; reasoning_details?: unknown }> }
    ).messages?.find((message) => message.role === "assistant");
    expect(replayedAssistant?.reasoning_details).toEqual([reasoningDetail]);
  });

  it.each([
    { modelId: "openai/gpt-5.6-luna", expectedRole: "developer" },
    { modelId: "anthropic/claude-sonnet-4.6", expectedRole: "developer" },
    { modelId: "moonshotai/kimi-k2.6", expectedRole: "system" },
  ])("uses $expectedRole instructions for OpenRouter model $modelId", async (testCase) => {
    let payload: unknown;
    const model = createModel({
      id: testCase.modelId,
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    });

    await streamOpenAICompletions(
      model,
      { ...context, systemPrompt: "Follow instructions." },
      {
        apiKey: "test",
        onPayload(nextPayload) {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    expect((payload as { messages?: Array<{ role?: string }> }).messages?.[0]?.role).toBe(
      testCase.expectedRole,
    );
  });

  it("sends configured OpenRouter routing through a compatible proxy", async () => {
    let payload: unknown;
    const routing = { only: ["google-vertex"] };
    const model = createModel({ compat: { openRouterRouting: routing } });

    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      onPayload(nextPayload) {
        payload = nextPayload;
        throw new Error("payload captured");
      },
    }).result();

    expect((payload as { provider?: unknown }).provider).toEqual(routing);
  });

  it.each([
    {
      name: "OpenAI",
      model: createModel({ compat: { sendSessionAffinityHeaders: true } }),
      expectedHeaders: {
        session_id: "session-123",
        "x-client-request-id": "session-123",
        "x-session-affinity": "session-123",
      },
    },
    {
      name: "OpenRouter",
      model: createModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: { sendSessionAffinityHeaders: true },
      }),
      expectedHeaders: { "x-session-id": "session-123" },
    },
    {
      name: "OpenRouter-compatible proxy",
      model: createModel({
        compat: {
          sendSessionAffinityHeaders: true,
          thinkingFormat: "openrouter",
        },
      }),
      expectedHeaders: { "x-session-id": "session-123" },
    },
  ])("sends exact $name session-affinity headers", async ({ model, expectedHeaders }) => {
    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      sessionId: "session-123",
    }).result();

    const clientOptions = mockOpenAI.clientOptions[0] as {
      defaultHeaders?: Record<string, string>;
    };
    expect(clientOptions.defaultHeaders).toEqual(expectedHeaders);
  });

  it("retains replayed Z.AI thinking when reasoning is enabled", async () => {
    let payload: unknown;
    const model = createModel({
      id: "glm-test",
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
    });
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "thinking",
          thinking: "prior reasoning",
          thinkingSignature: "reasoning_content",
        },
        { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    };

    await streamOpenAICompletions(
      model,
      {
        messages: [
          userMessage,
          assistant,
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "done" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      {
        apiKey: "test",
        reasoningEffort: "high",
        onPayload(nextPayload) {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    const request = payload as {
      thinking?: unknown;
      messages?: Array<Record<string, unknown>>;
    };
    expect(request.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(request.messages?.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_content: "prior reasoning",
    });
  });

  it.each([
    { configured: undefined, expected: 0 },
    { configured: 3, expected: 3 },
  ])("uses maxRetries=$expected when configured value is $configured", async (testCase) => {
    await streamOpenAICompletions(baseModel, context, {
      apiKey: "test",
      maxRetries: testCase.configured,
    }).result();

    expect(mockOpenAI.requestOptions[0]).toMatchObject({ maxRetries: testCase.expected });
  });

  it("surfaces HTTP response body text from OpenAI-compatible errors", async () => {
    mockOpenAI.nextError = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: "gateway maintenance",
    });

    const result = await streamOpenAICompletions(baseModel, context, {
      apiKey: "test",
    }).result();

    expect(result.errorMessage).toBe("502: gateway maintenance");
  });
});
