import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { streamAnthropic } from "./anthropic.js";

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

  it("preserves provider-signed Anthropic thinking text on replay", async () => {
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
    expect(assistantMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
      {
        type: "thinking",
        thinking: "sanitizesynthetic",
        signature: "reasoning_content",
      },
    ]);
  });
});
