import type { Context, Model } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";

export const anthropicModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

export const context = {
  systemPrompt: "Be exact.",
  messages: [{ role: "user", content: "Find the answer.", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a value.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Context;

export const anthropicEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_parity",
      model: "claude-sonnet-4-6-response",
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "seed", signature: "seed-signature" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " + thought" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "final-signature" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "Hello" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: " world" },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 7, output_tokens: 5 },
  },
  { type: "message_stop" },
] satisfies Record<string, unknown>[];

export function createAnthropicResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req-parity" },
  });
}

export function registerParityHostLifecycle() {
  let initialHost: ReturnType<typeof getAiTransportHost>;

  beforeAll(() => {
    initialHost = getAiTransportHost();
  });

  afterEach(() => {
    configureAiTransportHost(initialHost);
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    configureAiTransportHost(initialHost);
  });
}
