// Anthropic provider tests cover stream events, tools, and message mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../agents/system-prompt-cache-boundary.js";
import type { Context, Model } from "../types.js";

const anthropicMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
  });

  it("keeps Cloudflare AI Gateway upstream provider auth on the Anthropic API key", async () => {
    const model = makeAnthropicModel({
      provider: "cloudflare-ai-gateway",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
      headers: {
        "cf-aig-authorization": "Bearer gateway-token",
      },
    });
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "sk-ant-provider",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
      defaultHeaders?: Record<string, string | null>;
    };

    expect(config.apiKey).toBe("sk-ant-provider");
    expect(config.authToken).toBeNull();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
  });

  it("preserves provider-signed Anthropic thinking and drops reasoning_content placeholders", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    let capturedPayload: unknown;
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                { type: "message_stop" },
              ]),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [
          { role: "user", content: "hello", timestamp: 0 },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [
              {
                type: "thinking",
                thinking: signedThinking,
                thinkingSignature: "sig_1",
              },
              {
                type: "thinking",
                thinking: `sanitize${highSurrogate}synthetic`,
                thinkingSignature: "reasoning_content",
              },
            ],
          },
          { role: "user", content: "again", timestamp: 0 },
        ],
      },
      {
        apiKey: "sk-ant-provider",
        client: client as never,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(JSON.stringify(assistantMessage?.content)).not.toContain("reasoning_content");
    expect(assistantMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
    ]);
  });

  it("clamps max adaptive effort when the Claude model does not advertise it", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
      effort: "high",
    });
  });

  it("forwards simple stop sequences to Anthropic stop_sequences", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        stop: ["STOP"],
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { stop_sequences?: unknown }).stop_sequences).toEqual(["STOP"]);
  });

  it("splits the system prompt cache boundary into cached and uncached Anthropic blocks", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel(),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { system?: unknown }).system).toEqual([
      {
        type: "text",
        text: "Stable prefix",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "Dynamic suffix",
      },
    ]);
  });

  it("emits start event only after message_start so pre-stream SSE errors arrive before any non-error event", async () => {
    function createSseEventResponse(lines: string): Response {
      return new Response(lines, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseEventResponse(
                "event: message_start\ndata: " +
                  JSON.stringify({
                    type: "message_start",
                    message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
                  }) +
                  "\n\nevent: message_stop\ndata: " +
                  JSON.stringify({ type: "message_stop" }) +
                  "\n\n",
              ),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { apiKey: "sk-ant-key", client: client as never },
    );

    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    // start must come after message_start processing, not before the loop
    const startIndex = eventTypes.indexOf("start");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    // No error before start — the start event should be first non-error event
    const errorBeforeStart = eventTypes.slice(0, startIndex).some((t) => t === "error");
    expect(errorBeforeStart).toBe(false);
  });

  it("emits error without a preceding start event when SSE error arrives before message_start", async () => {
    function createSseEventResponse(lines: string): Response {
      return new Response(lines, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseEventResponse(
                "event: error\ndata: " +
                  JSON.stringify({
                    type: "invalid_request_error",
                    message: "messages.1.content.63: Invalid signature in thinking block",
                  }) +
                  "\n\n",
              ),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { apiKey: "sk-ant-key", client: client as never },
    );

    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    // error must be the first event — no start emitted before it
    expect(eventTypes[0]).toBe("error");
    expect(eventTypes).not.toContain("start");
  });

  it("strips the internal cache boundary when Anthropic cache control is disabled", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel(),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        cacheRetention: "none",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { system?: unknown }).system).toEqual([
      {
        type: "text",
        text: "Stable prefix\nDynamic suffix",
      },
    ]);
  });
});
