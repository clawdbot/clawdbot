import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
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

export async function captureAnthropicRequest(
  implementation: "provider" | "transport",
  options: {
    model?: Partial<Model<"anthropic-messages">>;
    apiKey?: string;
    transportApi?: Model["api"];
    reasoning?: "low" | "off";
    cacheRetention?: "short" | "long" | "none";
    events?: readonly Record<string, unknown>[];
    context?: Context;
    thinkingOverride?: { type: "disabled" } | { type: "enabled"; budget_tokens: number };
    headers?: Record<string, string>;
    cacheTtlPruning?: { tools?: { allow?: string[]; deny?: string[] } };
    anthropicServerCompaction?: boolean;
    anthropicCompactThreshold?: number;
    contextManagement?: unknown;
  } = {},
) {
  const requests: Array<{ payload: Record<string, unknown>; headers: Headers }> = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
  const fetchMock: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON Anthropic request body");
    }
    const payload: unknown = JSON.parse(init.body);
    if (!isRecord(payload)) {
      throw new Error("Expected an Anthropic request object");
    }
    requests.push({
      payload,
      headers: new Headers(init?.headers),
    });
    return createAnthropicResponse(options.events ?? anthropicEvents);
  };
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => fetchMock,
    logInfo: (_subsystem, message) => info.push(message),
    logWarn: (_subsystem, message) => warnings.push(message),
    resolveProviderRequestCapabilities: (input) => ({
      ...capabilities,
      endpointClass:
        new URL(input.baseUrl ?? "https://api.anthropic.com").hostname === "api.anthropic.com"
          ? "anthropic-public"
          : "custom",
    }),
  });
  const model = { ...anthropicModel, ...options.model };
  const streamOptions = {
    apiKey: options.apiKey ?? "sk-test",
    reasoning: options.reasoning ?? "low",
    cacheRetention: options.cacheRetention,
    headers: options.headers,
    cacheTtlPruning: options.cacheTtlPruning,
    anthropicServerCompaction: options.anthropicServerCompaction,
    anthropicCompactThreshold: options.anthropicCompactThreshold,
    onPayload: (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("Expected an Anthropic request object");
      }
      if (options.thinkingOverride) {
        payload.thinking = options.thinkingOverride;
      }
      if (options.contextManagement !== undefined) {
        payload.context_management = options.contextManagement;
      }
    },
  } as const;
  const [{ streamSimpleAnthropic }, { createAnthropicMessagesTransportStreamFn }] =
    await Promise.all([
      import("./providers/anthropic.js"),
      import("./transports/anthropic-transport-stream.js"),
    ]);
  const requestContext = options.context ?? context;
  const stream =
    implementation === "provider"
      ? streamSimpleAnthropic(model, requestContext, streamOptions)
      : await Promise.resolve(
          createAnthropicMessagesTransportStreamFn()(
            { ...model, api: options.transportApi ?? model.api },
            requestContext,
            streamOptions,
          ),
        );
  const result = await stream.result();
  expect(result.stopReason).toBe("stop");
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) {
    throw new Error("Expected one Anthropic request");
  }
  return { ...request, warnings, info };
}
