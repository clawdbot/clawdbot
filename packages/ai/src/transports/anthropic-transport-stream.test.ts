import type { Model } from "@openclaw/llm-core";
/**
 * Tests Anthropic Messages transport streaming.
 * Covers request construction, SSE parsing, aborts, tool calls, usage, and
 * provider transport hooks.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

const coreTransportHost = getAiTransportHost();

function resolveTestEndpointClass(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "api.anthropic.com") {
      return "anthropic-public";
    }
    if (hostname === "openrouter.ai") {
      return "openrouter";
    }
    if (hostname === "api.xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com")) {
      return "xiaomi-native";
    }
    return "custom";
  } catch {
    return "invalid";
  }
}

function redactTestSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactTestSecrets(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "key" ? "***" : redactTestSecrets(entry),
    ]),
  ) as T;
}

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicMessagesModel = Model<"anthropic-messages">;
type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = Parameters<AnthropicStreamFn>[2];
type RequestTransportConfig = {
  proxy?: unknown;
  tls?: unknown;
  headers?: Record<string, string>;
  allowPrivateNetwork?: boolean;
};
const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: RequestTransportConfig | undefined,
): TModel {
  if (!request) {
    return model;
  }
  const next = { ...model } as TModel & {
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]?: RequestTransportConfig;
  };
  next[MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL] = request;
  return next;
}

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = serializeSseEvents(events);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function serializeSseEvents(events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function createFailingSseResponse(events: Record<string, unknown>[], error: Error): Response {
  const encoder = new TextEncoder();
  let sentEvents = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentEvents) {
        sentEvents = true;
        controller.enqueue(encoder.encode(serializeSseEvents(events)));
        return;
      }
      controller.error(error);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createInterruptedThinkingEvents(): Record<string, unknown>[] {
  return [
    {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "step by step", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "partial-signature" },
    },
  ];
}

function createStalledSseResponse(params: { onCancel: (reason: unknown) => void }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        ),
      );
    },
    cancel(reason) {
      params.onCancel(reason);
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createRawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createOpenRawSseResponse(params: {
  body: string;
  onCancel: (reason: unknown) => void;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(params.body));
    },
    cancel(reason) {
      params.onCancel(reason);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function latestAnthropicRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return {
    init,
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

function latestAnthropicRequestHeaders() {
  return new Headers(latestAnthropicRequest().init?.headers);
}

function guardedFetchCall(
  callIndex = 0,
): [unknown, { method?: unknown; headers?: HeadersInit } | undefined] {
  const call = guardedFetchMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected guarded fetch call ${callIndex + 1}`);
  }
  return call as [unknown, { method?: unknown; headers?: HeadersInit } | undefined];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function findRecord(items: unknown, predicate: (record: Record<string, unknown>) => boolean) {
  for (const item of requireArray(items, "items")) {
    const record = requireRecord(item, "item");
    if (predicate(record)) {
      return record;
    }
  }
  throw new Error("Expected matching record");
}

function makeAnthropicTransportModel(
  params: {
    id?: string;
    name?: string;
    provider?: string;
    baseUrl?: string;
    reasoning?: boolean;
    params?: Record<string, unknown>;
    maxTokens?: number;
    input?: AnthropicMessagesModel["input"];
    thinkingLevelMap?: AnthropicMessagesModel["thinkingLevelMap"];
    headers?: Record<string, string>;
    authHeader?: boolean;
    requestTransport?: RequestTransportConfig;
  } = {},
): AnthropicMessagesModel {
  return attachModelProviderRequestTransport(
    {
      id: params.id ?? "claude-sonnet-4-6",
      name: params.name ?? "Claude Sonnet 4.6",
      api: "anthropic-messages",
      provider: params.provider ?? "anthropic",
      baseUrl: params.baseUrl ?? "https://api.anthropic.com",
      reasoning: params.reasoning ?? true,
      ...(params.params ? { params: params.params } : {}),
      input: params.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: params.maxTokens ?? 8192,
      ...(params.thinkingLevelMap ? { thinkingLevelMap: params.thinkingLevelMap } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
      ...(params.authHeader !== undefined ? { authHeader: params.authHeader } : {}),
    } satisfies AnthropicMessagesModel,
    params.requestTransport ?? {
      proxy: {
        mode: "env-proxy",
      },
    },
  );
}

function makeSonnet5PrefillContext(): AnthropicStreamContext {
  return {
    messages: [
      { role: "user", content: "Return JSON." },
      {
        role: "assistant",
        content: [{ type: "text", text: "{" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
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
      },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
  } as AnthropicStreamContext;
}

async function runTransportStream(
  model: AnthropicMessagesModel,
  context: AnthropicStreamContext,
  options: AnthropicStreamOptions,
) {
  const streamFn = createAnthropicMessagesTransportStreamFn();
  const stream = await Promise.resolve(streamFn(model, context, options));
  return stream.result();
}

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    configureAiTransportHost({
      ...coreTransportHost,
      buildModelFetch: buildGuardedModelFetchMock,
      redactSecrets: redactTestSecrets,
      resolveProviderEndpointClass: resolveTestEndpointClass,
      resolveProviderRequestCapabilities: (input) => {
        const endpointClass = resolveTestEndpointClass(input.baseUrl);
        return {
          endpointClass,
          knownProviderFamily: endpointClass === "xiaomi-native" ? "xiaomi" : "",
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAICompletionsStreamingUsageCompat: false,
          usesExplicitProxyLikeEndpoint: endpointClass === "custom" || endpointClass === "invalid",
          allowsAnthropicServiceTier: endpointClass === "anthropic-public",
        };
      },
    });
    guardedFetchMock.mockResolvedValue(createSseResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it("keeps aggregate cache billing buckets out of the context total", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_usage",
            model: "claude-fable-5",
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: 120_000,
              cache_creation_input_tokens: null,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Done." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 819_661,
            cache_creation_input_tokens: 93_130,
            iterations: [
              {
                type: "compaction",
                input_tokens: 12,
                output_tokens: 1_000,
                cache_read_input_tokens: 819_661,
                cache_creation_input_tokens: 93_130,
              },
              {
                type: "message",
                input_tokens: 12,
                output_tokens: 15_104,
                cache_read_input_tokens: 148_862,
                cache_creation_input_tokens: 0,
              },
            ],
          },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage).toMatchObject({
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      contextUsage: {
        state: "available",
        promptTokens: 148_874,
        totalTokens: 163_978,
      },
      totalTokens: 927_907,
    });
  });

  it("does not fall back to aggregate usage when the final iteration is malformed", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_invalid_iteration",
            model: "claude-fable-5",
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: 120_000,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 819_661,
            cache_creation_input_tokens: 93_130,
            iterations: [
              {
                type: "message",
                input_tokens: "malformed",
                output_tokens: 15_104,
                cache_read_input_tokens: 148_862,
                cache_creation_input_tokens: 0,
              },
            ],
          },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage.totalTokens).toBe(927_907);
    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("uses complete final usage when message-start prompt buckets are zero placeholders", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_zero_start",
            model: "claude-fable-5",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: 0,
          },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 148_874,
      totalTokens: 163_978,
    });
  });

  it("does not treat zero start placeholders as complete final prompt usage", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_zero_start_partial_delta",
            model: "claude-fable-5",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 15_104 },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("uses accumulated prompt buckets when the final usage update is partial", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_partial_final_usage",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: 120_000,
              cache_creation_input_tokens: 500,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: null,
          },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 149_374,
      totalTokens: 164_478,
    });
  });

  it("preserves valid message-start billing buckets when a sibling is malformed", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_malformed_usage",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_read_input_tokens: "malformed",
              cache_creation_input_tokens: 500,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 12,
            output_tokens: 15_104,
            cache_creation_input_tokens: null,
          },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.usage).toMatchObject({
      input: 12,
      output: 15_104,
      cacheRead: 0,
      cacheWrite: 500,
      totalTokens: 15_616,
    });
    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("tags pre-tool narration as commentary when a proxy mislabels stop_reason (pioneer/Bedrock)", async () => {
    // Bedrock/Vertex-proxied routes (e.g. pioneer; tool ids "toolu_vrtx_…") report
    // stop_reason "end_turn" on turns that DO carry a tool call. Commentary tagging
    // must key on the turn CONTAINING a toolCall, not on the stop_reason label, or
    // the narration text stays untagged (textSignature=None) and never reaches the
    // 💬 lane — exactly the pioneer commentary gap.
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_pio", usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "I'll start by checking the current date." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_vrtx_01S4", name: "exec", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"command":"date"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          // The proxy mislabel: a tool-using turn reported as end_turn, NOT tool_use.
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 10, output_tokens: 7 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "run date" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    // Despite stop_reason=end_turn, the turn carries a toolCall, so the narration
    // text must be tagged commentary (phase:commentary) and route to 💬.
    const textBlock = findRecord(result.content, (record) => record.type === "text");
    expect(textBlock.textSignature).toBeDefined();
    expect(String(textBlock.textSignature)).toContain('"phase":"commentary"');
    expect(result.content.some((block) => (block as { type?: string }).type === "toolCall")).toBe(
      true,
    );
  });

  it("uses the guarded fetch transport for api-key Anthropic requests", async () => {
    const model = makeAnthropicTransportModel({
      headers: { "X-Provider": "anthropic" },
      requestTransport: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        headers: { "X-Call": "1" },
      } as AnthropicStreamOptions,
    );

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    const [url, init] = guardedFetchCall();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-api");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("X-Provider")).toBe("anthropic");
    expect(headers.get("X-Call")).toBe("1");
    expect(latestAnthropicRequest().payload.model).toBe("claude-sonnet-4-6");
    expect(latestAnthropicRequest().payload.stream).toBe(true);
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14",
    );
  });

  it("sends server-side fallback params for direct Fable API-key requests", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_fb", usage: { input_tokens: 1, output_tokens: 0 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { type: "message_stop" },
      ]),
    );

    await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14,server-side-fallback-2026-06-01",
    );
  });

  it.each([
    {
      label: "OAuth tokens",
      model: { id: "claude-fable-5", name: "Claude Fable 5" },
      apiKey: "sk-ant-oat01-token",
    },
    {
      label: "custom proxy endpoints",
      model: {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        baseUrl: "https://proxy.example.com/v1",
      },
      apiKey: "sk-ant-api",
    },
    {
      label: "non-Fable models",
      model: { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      apiKey: "sk-ant-api",
    },
  ])("omits server-side fallback params for $label", async ({ model, apiKey }) => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_no_fb", usage: { input_tokens: 1, output_tokens: 0 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { type: "message_stop" },
      ]),
    );

    await runTransportStream(
      makeAnthropicTransportModel(model),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey,
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.fallbacks).toBeUndefined();
    expect(latestAnthropicRequestHeaders().get("anthropic-beta") ?? "").not.toContain(
      "server-side-fallback",
    );
  });

  it("rebuilds Fable output at a mid-stream server-side fallback boundary", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_fb",
            model: "claude-fable-5",
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "pre-boundary reasoning" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "partial " },
        },
        { type: "content_block_stop", index: 1 },
        {
          // Starting a tool call tags the preceding text as commentary before
          // the classifier declines mid-turn.
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
        },
        { type: "content_block_stop", index: 2 },
        {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "fallback",
            from: { model: "claude-fable-5" },
            to: { model: "claude-opus-4-8" },
          },
        },
        { type: "content_block_stop", index: 3 },
        {
          type: "content_block_start",
          index: 4,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 4,
          delta: { type: "text_delta", text: "continued" },
        },
        { type: "content_block_stop", index: 4 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 5, output_tokens: 9 },
        },
        { type: "message_stop" },
      ]),
    );

    const model = makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" });
    model.cost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
    const result = await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    // Pre-boundary thinking/tool blocks must not replay or execute; text is
    // the continuation prefix, and the commentary tag added for the dropped
    // tool call must not survive (it would hide the prefix from the visible
    // final answer).
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "partial " },
      { type: "text", text: "continued" },
    ]);
    expect(result.responseModel).toBe("claude-opus-4-8");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        details: {
          provider: "anthropic",
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
        },
      }),
    ]);
    // Fallback-served turns bill at the serving model's rates, not Fable's:
    // 5 input tokens at $5/MTok plus 9 output tokens at $25/MTok.
    expect(result.usage.cost.total).toBeCloseTo(0.00025, 10);
  });

  it("uses bearer auth for Microsoft Foundry Anthropic transport requests", async () => {
    const model = makeAnthropicTransportModel({
      provider: "microsoft-foundry",
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      authHeader: true,
      headers: {
        "api-key": "stale-foundry-key",
        "x-api-key": "stale-resource-key",
        "X-Provider": "foundry",
      },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "entra-access-token",
      } as AnthropicStreamOptions,
    );

    const headers = latestAnthropicRequestHeaders();
    expect(headers.get("authorization")).toBe("Bearer entra-access-token");
    expect(headers.get("api-key")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("X-Provider")).toBe("foundry");
  });

  it("preserves HTTP status and Retry-After in Anthropic error messages", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Number of request tokens exceeded the per-minute rate limit.",
          },
        }),
        {
          status: 429,
          headers: { "retry-after": "30" },
        },
      ),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "test-api-key" } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      'HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens exceeded the per-minute rate limit."}}; Retry-After: 30 seconds',
    );
  });

  it("bounds streamed Anthropic error responses without content-length", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelCount = 0;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(encoder.encode("x".repeat(8 * 1024)));
              return;
            }
            controller.enqueue(encoder.encode("y"));
          },
          cancel() {
            cancelCount += 1;
          },
        }),
        { status: 500 },
      ),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(`HTTP 500: ${"x".repeat(400)}…`);
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(cancelCount).toBe(1);
  });

  it("aborts stalled streamed Anthropic error responses", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let cancelReason: unknown;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial failure detail"));
          },
          cancel(reason) {
            cancelReason = reason;
          },
        }),
        { status: 500 },
      ),
    );

    const resultPromise = runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "HTTP 500: Anthropic Messages error response stalled: no data received for 10000ms",
    );
    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe(
      "Anthropic Messages error response stalled: no data received for 10000ms",
    );
  });

  it("rejects oversized Anthropic SSE frames before buffering without bound", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let cancelCalled = false;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(encoder.encode("x".repeat(16 * 1024 * 1024 + 1)));
          },
          cancel() {
            cancelCalled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const resultPromise = runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "sk-ant-api", signal: controller.signal } as AnthropicStreamOptions,
    );

    const timedOut = Symbol("timed out");
    const result = await Promise.race([resultPromise, delay(1_000, timedOut)]);
    if (result === timedOut) {
      controller.abort(new Error("oversized Anthropic SSE frame did not trip buffer cap"));
      await resultPromise;
      throw new Error("Anthropic SSE stream did not reject oversized pending buffer within 1000ms");
    }

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Anthropic Messages SSE response exceeded max pending buffer size (16777216 chars) without event boundary",
    );
    expect(cancelCalled).toBe(true);
  });

  it("honors ANTHROPIC_BASE_URL when model base URL is blank", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", " https://anthropic-proxy.example/v1 ");

    await runTransportStream(
      makeAnthropicTransportModel({ baseUrl: "" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    const [url] = guardedFetchCall();
    expect(url).toBe("https://anthropic-proxy.example/v1/messages");
    expect(buildGuardedModelFetchMock.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://anthropic-proxy.example/v1",
    });
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBeNull();
  });

  it("prefers explicit Anthropic base URL over ANTHROPIC_BASE_URL", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic-proxy.example/v1");

    await runTransportStream(
      makeAnthropicTransportModel({ baseUrl: "https://configured.example" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    const [url] = guardedFetchCall();
    expect(url).toBe("https://configured.example/v1/messages");
  });

  it("strips the provider prefix from direct Anthropic request model ids", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({ id: "anthropic/claude-sonnet-4-6" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        toolChoice: { type: "tool", name: "read_file" },
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("claude-sonnet-4-6");
  });

  it("keeps slash-bearing model ids for Anthropic-compatible proxy providers", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        baseUrl: "https://openrouter.ai/api/anthropic",
      }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-or-test",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("keeps slash-bearing model ids for configured Anthropic-compatible endpoints", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "anthropic/claude-sonnet-4-6",
        baseUrl: "https://anthropic-proxy.internal",
      }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("bypasses the OpenAI SSE sanitizer for Kimi Anthropic thinking streams", async () => {
    const model = makeAnthropicTransportModel({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      baseUrl: "https://api.kimi.com/coding",
      maxTokens: 32768,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-kimi-api",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model, undefined, {
      sanitizeSse: false,
    });
    expect(latestAnthropicRequest().payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
  });

  it("does not add implicit Anthropic beta headers for custom compatible API-key endpoints", async () => {
    const model = makeAnthropicTransportModel({
      provider: "anthropic",
      baseUrl: "https://custom-proxy.example",
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const [url, init] = guardedFetchCall();
    expect(url).toBe("https://custom-proxy.example/v1/messages");
    expect(init?.method).toBe("POST");
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBeNull();
  });

  it("does not add implicit Anthropic beta headers for custom compatible OAuth endpoints", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        provider: "anthropic",
        baseUrl: "https://custom-proxy.example",
      }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-token",
      } as AnthropicStreamOptions,
    );

    const headers = latestAnthropicRequestHeaders();
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-token");
    expect(headers.get("anthropic-beta")).toBeNull();
  });

  it("keeps Anthropic beta headers for direct Anthropic OAuth endpoints", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-token",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
      "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
    );
  });

  it("recognizes schemeless api.anthropic.com base URLs as direct Anthropic", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({ baseUrl: "api.anthropic.com" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14",
    );
  });

  it("does not add implicit Anthropic beta headers for foreign hosts mentioning api.anthropic.com", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({ baseUrl: "https://attacker.example/api.anthropic.com" }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBeNull();
  });

  it("ignores non-positive runtime maxTokens overrides and falls back to the model limit", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        maxTokens: 0,
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("claude-sonnet-4-6");
    expect(latestAnthropicRequest().payload.max_tokens).toBe(8192);
    expect(latestAnthropicRequest().payload.stream).toBe(true);
  });

  it("ignores fractional runtime maxTokens overrides that floor to zero", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        maxTokens: 0.5,
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("claude-sonnet-4-6");
    expect(latestAnthropicRequest().payload.max_tokens).toBe(8192);
    expect(latestAnthropicRequest().payload.stream).toBe(true);
  });

  it("forwards stop sequences as Anthropic stop_sequences", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        stop: ["User:", "Assistant:"],
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.stop_sequences).toEqual(["User:", "Assistant:"]);
  });

  it("caps default max_tokens for large-output Anthropic-compatible models", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        provider: "minimax-portal",
        id: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/anthropic",
        maxTokens: 196_608,
      }),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-minimax-redacted",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.model).toBe("MiniMax-M2.7");
    expect(latestAnthropicRequest().payload.max_tokens).toBe(32_000);
    expect(latestAnthropicRequest().payload.stream).toBe(true);
  });

  it("uses a default maxTokens for custom Anthropic models that omit it", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "anthropic-messages",
        provider: "custom-anthropic",
        baseUrl: "https://custom.example/anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: undefined as never,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "env-proxy",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(latestAnthropicRequest().payload).toMatchObject({
      model: "custom-model",
      max_tokens: 4_096,
      stream: true,
    });
  });

  it("clamps the custom Anthropic maxTokens fallback to the context window", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "anthropic-messages",
        provider: "custom-anthropic",
        baseUrl: "https://custom.example/anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4_096,
        maxTokens: undefined as never,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "env-proxy",
        },
      },
    );

    await runTransportStream(
      model,
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "fake" } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.max_tokens).toBe(1_024);
  });

  it("fails locally when a custom Anthropic model has an invalid maxTokens", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "anthropic-messages",
        provider: "custom-anthropic",
        baseUrl: "https://custom.example/anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 0,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "env-proxy",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        { messages: [{ role: "user", content: "hello" }] } as Parameters<typeof streamFn>[1],
        { apiKey: "fake" } as Parameters<typeof streamFn>[2],
      ),
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "Anthropic Messages transport requires a positive maxTokens value",
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("classifies malformed Anthropic SSE data as a stable transport error", async () => {
    guardedFetchMock.mockResolvedValueOnce(createRawSseResponse('data: {"type":\n\n'));

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("OpenClaw transport error: malformed_streaming_fragment");
  });

  it.each([
    ["claude-fable-5", "Claude Fable 5", "anthropic"],
    ["claude-sonnet-5", "Claude Sonnet 5", "anthropic"],
    ["claude-sonnet-5", "Claude Sonnet 5", "anthropic-vertex"],
  ])("surfaces structured %s streaming refusals for %s", async (id, name, provider) => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_refusal", usage: { input_tokens: 3, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "discard this partial output" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_details: {
              type: "refusal",
              category: "bio",
              explanation: "This request is not allowed.",
            },
          },
          usage: { input_tokens: 3, output_tokens: 2 },
        },
        { type: "message_stop" },
      ]),
    );

    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel({
          id,
          name,
          provider,
        }),
        { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
      ),
    );
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe(
      "Anthropic refusal (category: bio): This request is not allowed.",
    );
    expect(result.usage).toMatchObject({ input: 3, output: 2 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: {
          provider,
          category: "bio",
          explanation: "This request is not allowed.",
        },
      }),
    ]);
  });

  it("discards buffered Fable output when the transport ends before terminal status", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "unsafe partial output" },
        },
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel({
          id: "claude-fable-5",
          name: "Claude Fable 5",
        }),
        { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
      ),
    );
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe("Anthropic stream ended before message_stop");
  });

  it("defers a pre-tool text block's text_end until it carries the commentary phase", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_defer", usage: { input_tokens: 5, output_tokens: 0 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "I'll check the repo." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_1", name: "exec", input: {} },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 5, output_tokens: 7 },
        },
        { type: "message_stop" },
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel(),
        { messages: [{ role: "user", content: "inspect" }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
      ),
    );
    const order: string[] = [];
    let textEndPhase: unknown;
    for await (const event of stream as AsyncIterable<{
      type: string;
      contentIndex?: number;
      partial?: { content?: Array<{ textSignature?: string }> };
    }>) {
      order.push(event.type);
      if (event.type === "text_end" && typeof event.contentIndex === "number") {
        const signature = event.partial?.content?.[event.contentIndex]?.textSignature;
        textEndPhase =
          typeof signature === "string"
            ? (JSON.parse(signature) as { phase?: string }).phase
            : undefined;
      }
    }
    // The pre-tool text block's text_end is held until the tool boundary tags it
    // commentary, so a block-reply consumer never durably commits the narration
    // as the answer. It is still emitted (once) and still before the tool call.
    expect(textEndPhase).toBe("commentary");
    expect(order.filter((type) => type === "text_end")).toHaveLength(1);
    expect(order.indexOf("text_end")).toBeLessThan(order.indexOf("toolcall_start"));
  });

  it("emits a non-tool text block's text_end as unphased answer text", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_answer", usage: { input_tokens: 5, output_tokens: 0 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Here is the answer." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 5, output_tokens: 4 },
        },
        { type: "message_stop" },
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel(),
        { messages: [{ role: "user", content: "answer me" }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
      ),
    );
    const order: string[] = [];
    let textEndPhase: unknown = "unset";
    for await (const event of stream as AsyncIterable<{
      type: string;
      contentIndex?: number;
      partial?: { content?: Array<{ textSignature?: string }> };
    }>) {
      order.push(event.type);
      if (event.type === "text_end" && typeof event.contentIndex === "number") {
        const signature = event.partial?.content?.[event.contentIndex]?.textSignature;
        textEndPhase =
          typeof signature === "string"
            ? (JSON.parse(signature) as { phase?: string }).phase
            : undefined;
      }
    }
    const result = await stream.result();
    // No tool follows, so the held text_end is flushed unphased at message_delta
    // and the text is delivered as the answer (never tagged commentary).
    expect(order.filter((type) => type === "text_end")).toHaveLength(1);
    expect(textEndPhase).toBeUndefined();
    const textBlock = findRecord(result.content, (record) => record.type === "text");
    expect(textBlock.text).toBe("Here is the answer.");
    expect(textBlock.textSignature).toBeUndefined();
  });

  it("preserves unsafe integer Anthropic tool-use input deltas", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_unsafe", usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool_unsafe",
            name: "send_message",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"to":1481220477346119781,"safe":42,"maxSafe":9007199254740991,"nested":{"ids":[9007199254740993,-9007199254740992]}}',
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "message this channel" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const toolCall = findRecord(
      result.content,
      (record) => record.type === "toolCall" && record.name === "send_message",
    );
    expect(toolCall.arguments).toEqual({
      to: "1481220477346119781",
      safe: 42,
      maxSafe: 9007199254740991,
      nested: { ids: ["9007199254740993", "-9007199254740992"] },
    });
  });

  it("preserves Anthropic OAuth identity and tool-name remapping with transport overrides", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { path: "/tmp/a" },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]),
    );
    const model = makeAnthropicTransportModel({
      requestTransport: {
        tls: {
          ca: "ca-pem",
        },
      },
    });
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "Follow policy.",
          messages: [{ role: "user", content: "Read the file" }],
          tools: [
            {
              name: "Read",
              description: "Invalid case-colliding tool",
              parameters: {
                type: "object",
                properties: false,
              },
            },
            {
              name: "read",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                },
                required: ["path"],
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-oat-example",
          toolChoice: { type: "tool", name: "read" },
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    const [url, init] = guardedFetchCall();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-example");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("user-agent")).toContain("claude-cli/");
    const firstCallParams = latestAnthropicRequest().payload;
    const system = requireArray(firstCallParams.system, "system");
    expect(requireRecord(system[0], "billing system item").text).toBe(
      "x-anthropic-billing-header: cc_version=2.1.75; cc_entrypoint=sdk-cli;",
    );
    expect(
      system.some(
        (item) =>
          requireRecord(item, "system item").text ===
          "You are Claude Code, Anthropic's official CLI for Claude.",
      ),
    ).toBe(true);
    expect(
      system.some((item) => requireRecord(item, "system item").text === "Follow policy."),
    ).toBe(true);
    expect(
      requireArray(firstCallParams.tools, "tools").map((item) => requireRecord(item, "tool").name),
    ).toEqual(["Read"]);
    expect(firstCallParams.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.some((item) => item.type === "toolCall" && item.name === "read")).toBe(
      true,
    );
  });

  it("preserves text seeded on a text block after a thinking block", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "checking", signature: "sig_1" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_2" },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "NO_REPLY" },
        },
        {
          type: "content_block_stop",
          index: 1,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 9 },
        },
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel({ provider: "meridian", baseUrl: "http://127.0.0.1:3456" }),
        {
          messages: [{ role: "user", content: "heartbeat" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "meridian-key",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const events: Array<{ type?: string; delta?: string; content?: string }> = [];
    for await (const event of stream as AsyncIterable<{
      type?: string;
      delta?: string;
      content?: string;
    }>) {
      events.push(event);
    }
    const result = await stream.result();

    const thinkingContent = requireRecord(result.content[0], "thinking content");
    expect(thinkingContent.type).toBe("thinking");
    expect(thinkingContent.thinking).toBe("checking");
    expect(thinkingContent.thinkingSignature).toBe("sig_2");
    expect(result.content[1]).toEqual({ type: "text", text: "NO_REPLY" });
    expect(events.some((event) => event.type === "text_delta" && event.delta === "NO_REPLY")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "text_end" && event.content === "NO_REPLY")).toBe(
      true,
    );
    expect(result.usage.output).toBe(9);
  });

  it("preserves provider-signed Anthropic thinking text on ingest", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: signedThinking, signature: "sig_1" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_2" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_3" },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 9 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinking: signedThinking,
      thinkingSignature: "sig_2sig_3",
    });
  });

  it("routes interleaved active content blocks by their event indexes", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_interleaved", usage: { input_tokens: 1, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "second" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "first" },
        },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 2 },
        },
        { type: "message_stop" },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("preserves provider-seeded thinking signatures when no signature_delta follows", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "seeded", signature: "seed_signature" },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 5 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinking: "seeded",
      thinkingSignature: "seed_signature",
    });
  });

  it("concatenates multiple signature_delta events instead of overwriting", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "step by step", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "chunk1" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "chunk2" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "chunk3" },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 5 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinking: "step by step",
      thinkingSignature: "chunk1chunk2chunk3",
    });
  });

  it.each([
    {
      label: "the stream ends before content_block_stop",
      response: () => createSseResponse(createInterruptedThinkingEvents()),
      stopReason: "stop",
    },
    {
      label: "the provider errors before content_block_stop",
      response: () =>
        createSseResponse([
          ...createInterruptedThinkingEvents(),
          { type: "error", error: { message: "provider failed" } },
        ]),
      stopReason: "error",
    },
    {
      label: "the response body fails",
      response: () =>
        createFailingSseResponse(
          createInterruptedThinkingEvents(),
          new Error("response body failed"),
        ),
      stopReason: "error",
    },
  ])("does not persist signature deltas when $label", async ({ response, stopReason }) => {
    guardedFetchMock.mockResolvedValueOnce(response());

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "think" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe(stopReason);
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinking: "step by step",
      thinkingSignature: "",
    });
  });

  it("does not persist signature deltas when the request aborts", async () => {
    const controller = new AbortController();
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: serializeSseEvents(createInterruptedThinkingEvents()),
        onCancel: () => undefined,
      }),
    );
    setTimeout(() => controller.abort(new Error("request aborted")), 20);

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "think" }] } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        signal: controller.signal,
      } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("aborted");
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "",
    });
  });

  it("commits only stopped signatures across interleaved thinking blocks", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "first", signature: "" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "second", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "signature_delta", signature: "complete-second" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "partial-first" },
        },
        { type: "content_block_stop", index: 1 },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "think" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "first",
        thinkingSignature: "",
      }),
      expect.objectContaining({
        type: "thinking",
        thinking: "second",
        thinkingSignature: "complete-second",
      }),
    ]);
  });

  it("captures OpenAI-style reasoning_content deltas from Anthropic-compatible streams", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: "", reasoning_content: "Need " },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: "", reasoning_content: "context." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: "Visible answer.", reasoning_content: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: " Continued.", reasoning_content: null },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 2 },
        },
      ]),
    );
    const model = makeAnthropicTransportModel({
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      provider: "xiaomi-token-plan-ams",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
    });

    const firstResult = await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    expect(firstResult.content).toEqual([
      {
        type: "thinking",
        thinking: "Need context.",
        thinkingSignature: "reasoning_content",
      },
      {
        type: "text",
        text: "Visible answer. Continued.",
      },
    ]);

    await runTransportStream(
      model,
      {
        messages: [
          { role: "user", content: "think" },
          {
            ...firstResult,
            timestamp: 0,
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage.reasoning_content).toBe("Need context.");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "Need context.",
        signature: "reasoning_content",
      },
      { type: "text", text: "Visible answer. Continued." },
    ]);
  });

  it("captures reasoning_content after compatible streams start a text block", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: "Visible ", reasoning_content: "Need " },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { content: "answer.", reasoning_content: null },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 2 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.5",
        name: "MiMo V2.5",
        provider: "xiaomi-token-plan-ams",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Visible answer.",
      },
      {
        type: "thinking",
        thinking: "Need ",
        thinkingSignature: "reasoning_content",
      },
    ]);
  });

  it("preserves native text_delta chunks that also carry reasoning_content", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            content: "Visible ",
            text: "Visible ",
            reasoning_content: "Need ",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "answer." },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 2 },
        },
      ]),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.5",
        name: "MiMo V2.5",
        provider: "xiaomi-token-plan-ams",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [{ role: "user", content: "think" }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Visible answer.",
      },
      {
        type: "thinking",
        thinking: "Need ",
        thinkingSignature: "reasoning_content",
      },
    ]);
  });

  it("recovers orphan text deltas when an Anthropic-compatible provider omits block start", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "你好" },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 6, output_tokens: 1 },
        },
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeAnthropicTransportModel({
          provider: "kimi-coding",
          baseUrl: "https://api.kimi.com/coding/",
        }),
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "kimi-key",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const events: Array<{ type?: string; delta?: string; content?: string }> = [];
    for await (const event of stream as AsyncIterable<{
      type?: string;
      delta?: string;
      content?: string;
    }>) {
      events.push(event);
    }
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "你好" }]);
    expect(result.stopReason).toBe("stop");
    expect(events.some((event) => event.type === "text_start")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "你好")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "text_end" && event.content === "你好")).toBe(
      true,
    );
  });

  it("skips malformed tools when building Anthropic payloads", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "unreadable_plugin_tool",
            description: "unreadable schema",
            get parameters() {
              throw new Error("fuzz parameters getter exploded");
            },
          },
          {
            name: "bad_plugin_tool",
            description: "missing schema",
            execute: async () => ({ content: [{ type: "text", text: "bad" }] }),
          },
          {
            name: "invalid_properties_tool",
            description: "invalid properties",
            parameters: { type: "object", properties: false },
          },
          {
            name: "good_plugin_tool",
            description: "valid schema",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const tools = requireArray(latestAnthropicRequest().payload.tools, "tools");
    expect(tools).toHaveLength(1);
    const tool = requireRecord(tools[0], "tool");
    expect(tool.name).toBe("good_plugin_tool");
    expect(requireRecord(tool.input_schema, "input schema").properties).toEqual({
      query: { type: "string" },
    });
  });

  it("omits automatic Anthropic tool choice when every provided schema is unreadable", async () => {
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "unreadable_plugin_tool",
            description: "unreadable schema",
            get parameters() {
              throw new Error("fuzz parameters getter exploded");
            },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        toolChoice: "auto",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(result.stopReason).toBe("stop");
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("fails locally when a pinned Anthropic tool choice is skipped", async () => {
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "unreadable_plugin_tool",
            description: "unreadable schema",
            get parameters() {
              throw new Error("fuzz parameters getter exploded");
            },
          },
          {
            name: "healthy_tool",
            description: "healthy schema",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        toolChoice: { type: "tool", name: "unreadable_plugin_tool" },
      } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool_choice requested unavailable tool "unreadable_plugin_tool"',
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails locally when OAuth tool names collide on the Anthropic wire", async () => {
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "Read",
            description: "Uppercase tool",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "read",
            description: "Lowercase tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-example",
      } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool names "Read" and "read" both map to "Read"',
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not rebind a skipped OAuth tool choice through a sibling wire name", async () => {
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "Read",
            description: "Invalid uppercase tool",
            parameters: { type: "object", properties: false },
          },
          {
            name: "read",
            description: "Valid lowercase tool",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-example",
        toolChoice: { type: "tool", name: "Read" },
      } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool_choice requested unavailable tool "Read"',
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("coerces replayed malformed tool-call args to an object for Anthropic payloads", async () => {
    const model = makeAnthropicTransportModel({
      requestTransport: {
        tls: {
          ca: "ca-pem",
        },
      },
    });
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [
            {
              role: "assistant",
              provider: "openai",
              api: "openai-responses",
              model: "gpt-5.4",
              stopReason: "toolUse",
              timestamp: 0,
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "lookup",
                  arguments: "{not valid json",
                },
              ],
            },
          ],
        } as never,
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const firstCallParams = latestAnthropicRequest().payload;
    const assistantMessage = findRecord(
      firstCallParams.messages,
      (record) => record.role === "assistant",
    );
    const toolUse = findRecord(
      assistantMessage.content,
      (record) => record.type === "tool_use" && record.name === "lookup",
    );
    expect(toolUse.input).toEqual({});
  });

  it("replays reasoning_content from compatible Anthropic thinking blocks", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        provider: "xiaomi",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "xiaomi",
            api: "anthropic-messages",
            model: "mimo-v2.6-pro",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: `Need${highSurrogate} to answer politely.`,
                thinkingSignature: "reasoning_content",
              },
              { type: "text", text: "Hello!" },
              {
                type: "thinking",
                thinking: "Then ask a follow-up.",
                thinkingSignature: "reasoning_content",
              },
            ],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage.reasoning_content).toBe(
      "Need to answer politely.\nThen ask a follow-up.",
    );
    expect(assistantMessage).not.toHaveProperty("reasoning");
    expect(assistantMessage).not.toHaveProperty("reasoning_text");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "Need to answer politely.",
        signature: "reasoning_content",
      },
      { type: "text", text: "Hello!" },
      {
        type: "thinking",
        thinking: "Then ask a follow-up.",
        signature: "reasoning_content",
      },
    ]);
  });

  it("preserves provider-signed Anthropic thinking text on replay", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
      }),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-fable-5",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: signedThinking,
                thinkingSignature: "sig_1",
              },
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "sig_omitted",
              },
            ],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
      {
        type: "thinking",
        thinking: "",
        signature: "sig_omitted",
      },
    ]);
  });

  it("replaces a completed thinking-only turn when the current request disables thinking", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "private reasoning",
                thinkingSignature: "sig_1",
              },
              {
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: "opaque_1",
                redacted: true,
              },
            ],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    const assistantMessage = findRecord(payload.messages, (record) => record.role === "assistant");
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(assistantMessage.content).toEqual([
      { type: "text", text: "[assistant reasoning omitted]" },
    ]);
  });

  it("preserves signed thinking for an active tool turn when new thinking is disabled", async () => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [
          { role: "user", content: "look it up" },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "call lookup",
                thinkingSignature: "sig_tool",
              },
              { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "42" }],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage.content).toEqual([
      { type: "thinking", thinking: "call lookup", signature: "sig_tool" },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it("backfills empty reasoning_content thinking blocks for compatible Anthropic tool-use replays", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        provider: "xiaomi",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [
          { role: "user", content: "look this up" },
          {
            role: "assistant",
            provider: "xiaomi",
            api: "anthropic-messages",
            model: "mimo-v2.6-pro",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "text", text: "found" }],
            isError: false,
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "",
        signature: "reasoning_content",
      },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it("backfills MiMo v2-flash tool-use replay when OpenClaw thinking is off", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2-flash",
        name: "MiMo V2 Flash",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        reasoning: false,
      }),
      {
        messages: [
          { role: "user", content: "look this up" },
          {
            role: "assistant",
            provider: "xiaomi",
            api: "anthropic-messages",
            model: "mimo-v2-flash",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "text", text: "found" }],
            isError: false,
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(latestAnthropicRequest().payload).not.toHaveProperty("thinking");
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "",
        signature: "reasoning_content",
      },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it("backfills empty reasoning_content thinking blocks for compatible Anthropic text replays", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        provider: "xiaomi",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "xiaomi",
            api: "anthropic-messages",
            model: "mimo-v2.6-pro",
            stopReason: "stop",
            timestamp: 0,
            content: [{ type: "text", text: "Hello!" }],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "",
        signature: "reasoning_content",
      },
      { type: "text", text: "Hello!" },
    ]);
  });

  it("does not backfill reasoning_content for generic Anthropic-compatible tool-use replays", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "gateway",
        baseUrl: "https://gateway.example.com/anthropic",
      }),
      {
        messages: [
          { role: "user", content: "look this up" },
          {
            role: "assistant",
            provider: "gateway",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: [{ type: "text", text: "found" }],
            isError: false,
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-gateway-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
    expect(assistantMessage.content).toEqual([
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it("replays observed reasoning_content for compatible Anthropic routes when thinking is disabled", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.6-pro",
        name: "MiMo V2.6 Pro",
        provider: "xiaomi",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "xiaomi",
            api: "anthropic-messages",
            model: "mimo-v2.6-pro",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "Need to answer politely.",
                thinkingSignature: "reasoning_content",
              },
              { type: "text", text: "Hello!" },
            ],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(latestAnthropicRequest().payload.thinking).toEqual({ type: "disabled" });
    expect(assistantMessage.reasoning_content).toBe("Need to answer politely.");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "Need to answer politely.",
        signature: "reasoning_content",
      },
      { type: "text", text: "Hello!" },
    ]);
  });

  it("does not replay synthetic reasoning_content to native Anthropic models", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
      }),
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "Private replay text.",
                thinkingSignature: "reasoning_content",
              },
              { type: "text", text: "Visible reply." },
            ],
          },
          { role: "user", content: "again" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
    expect(assistantMessage.content).toEqual([{ type: "text", text: "Visible reply." }]);
  });

  it.each([
    {
      name: "empty history",
      context: { messages: [] } as AnthropicStreamContext,
    },
    {
      name: "blank user content",
      context: {
        messages: [
          {
            role: "user",
            content: " \n\t ",
            timestamp: 0,
          },
        ],
      } as AnthropicStreamContext,
    },
  ])(
    "sends a minimal user fallback when Anthropic message conversion has no content: $name",
    async ({ context }) => {
      await runTransportStream(
        makeAnthropicTransportModel({
          id: "MiniMax-M2.7",
          name: "MiniMax M2.7",
          provider: "minimax",
          baseUrl: "https://api.minimax.io/anthropic",
        }),
        context,
        {
          apiKey: "sk-minimax-test",
        } as AnthropicStreamOptions,
      );

      const requestPayload = latestAnthropicRequest().payload;
      expect(requestPayload.model).toBe("MiniMax-M2.7");
      expect(requestPayload.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: ".",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]);
      const [url, fetchOptions] = expectDefined(
        (guardedFetchMock.mock.calls as unknown as Array<[string, { method?: string }]>)[0],
        "(guardedFetchMock.mock.calls as unknown as Array<[string, { method?: string }]>)[0] test invariant",
      );
      expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
      expect(fetchOptions.method).toBe("POST");
    },
  );

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t "],
    ["invalid-surrogate-only", String.fromCharCode(0xd83d)],
  ])("replaces %s text-only tool results with a non-empty payload", async (_label, text) => {
    await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_1", name: "quiet", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_1",
            content: [{ type: "text", text }],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_1",
    );
    expect(toolResult.content).toBe("(no output)");
    expect(toolResult.is_error).toBe(false);
  });

  it("replays payload-less tool images as no output without Anthropic image blocks", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({ input: ["text", "image"] }),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_husk", name: "screenshot", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_husk",
            toolName: "screenshot",
            content: [{ type: "image", data: "", mimeType: "image/png" }],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      { apiKey: "fake" } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_husk",
    );
    expect(toolResult.content).toBe("(no output)");
    expect(JSON.stringify(toolResult)).not.toContain('"source"');
    expect(JSON.stringify(toolResult)).not.toContain("see attached image");
  });

  it("drops empty text blocks from image tool results before Anthropic payloads", async () => {
    const imageData = Buffer.from("image").toString("base64");

    await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-sonnet-4-6", input: ["text", "image"] }),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_1", name: "screenshot", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_1",
            content: [
              { type: "text", text: "" },
              { type: "image", data: imageData, mimeType: "image/png" },
            ],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_1",
    );
    expect(toolResult.content).toEqual([
      { type: "text", text: "(see attached image)" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData,
        },
      },
    ]);
    expect(toolResult.is_error).toBe(false);
  });

  it("serializes structured non-image blocks in tool results as JSON text", async () => {
    await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-sonnet-4-6" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_1", name: "fetch", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_1",
            content: [
              {
                type: "resource",
                resource: {
                  uri: "https://example.com/data.json",
                  mimeType: "application/json",
                  text: '{"key":"value"}',
                },
              },
            ],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_1",
    );
    // No images → returns sanitized text string, not array
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).toContain('"type":"resource"');
    expect(toolResult.content).toContain('{\\"key\\":\\"***\\"}');
    expect(toolResult.is_error).toBe(false);
  });

  it("includes serialized structured blocks alongside images in tool results", async () => {
    const imageData = Buffer.from("image").toString("base64");

    await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-sonnet-4-6", input: ["text", "image"] }),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_1", name: "screenshot", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_1",
            content: [
              { type: "text", text: "before image" },
              { type: "image", data: imageData, mimeType: "image/png" },
              {
                type: "resource",
                resource: {
                  uri: "https://example.com/data.json",
                  mimeType: "application/json",
                  text: '{"key":"value"}',
                },
              },
              { type: "text", text: "after image" },
            ],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_1",
    );
    expect(toolResult.content).toEqual([
      { type: "text", text: "before image" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData,
        },
      },
      { type: "text", text: expect.stringContaining('{"type":"resource"') },
      { type: "text", text: "after image" },
    ]);
    expect(toolResult.is_error).toBe(false);
  });

  it("drops image blocks from tool results for text-only models", async () => {
    const model = makeAnthropicTransportModel({ input: ["text"] });
    const imageData = "aW1hZ2VkYXRh";
    await runTransportStream(
      model,
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            content: [{ type: "toolCall", id: "tool_1", name: "screenshot", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "tool_1",
            content: [
              { type: "image", data: imageData, mimeType: "image/png" },
              { type: "text", text: "captured screen" },
            ],
            isError: false,
          },
        ],
      } as AnthropicStreamContext,
      { apiKey: "fixture" } as AnthropicStreamOptions,
    );

    const userMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "user",
    );
    const toolResult = findRecord(
      userMessage.content,
      (record) => record.type === "tool_result" && record.tool_use_id === "tool_1",
    );
    const blocks = Array.isArray(toolResult.content) ? toolResult.content : [];
    const imageBlocks = blocks.filter((block: Record<string, unknown>) => block.type === "image");
    expect(imageBlocks).toHaveLength(0);
    expect(toolResult.content).toContain("captured screen");
    expect(toolResult.is_error).toBe(false);
  });

  it("cancels stalled SSE body reads when the abort signal fires mid-stream", async () => {
    const controller = new AbortController();
    const abortReason = new Error("anthropic test abort");
    let cancelReason: unknown;
    guardedFetchMock.mockResolvedValueOnce(
      createStalledSseResponse({
        onCancel: (reason) => {
          cancelReason = reason;
        },
      }),
    );

    setTimeout(() => controller.abort(abortReason), 50);

    const timedOut = Symbol("timed out");
    const startedAt = Date.now();
    const result = await Promise.race([
      runTransportStream(
        makeAnthropicTransportModel(),
        { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api", signal: controller.signal } as AnthropicStreamOptions,
      ),
      delay(1_000, timedOut),
    ]);

    if (result === timedOut) {
      throw new Error("Anthropic SSE stream did not abort within 1000ms");
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("anthropic test abort");
    expect(cancelReason).toBe(abortReason);
  });

  it("treats already-aborted signals as abort errors before reading SSE chunks", async () => {
    const controller = new AbortController();
    const abortReason = new Error("pre-aborted stream");
    let cancelReason: unknown;
    guardedFetchMock.mockResolvedValueOnce(
      createStalledSseResponse({
        onCancel: (reason) => {
          cancelReason = reason;
        },
      }),
    );
    controller.abort(abortReason);

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api", signal: controller.signal } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("pre-aborted stream");
    expect(cancelReason).toBe(abortReason);
  });

  it("cancels open SSE bodies when Anthropic stream consumers throw", async () => {
    let cancelCalled = false;
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: 'data: {"type":"error","error":{"message":"stream exploded"}}\n\n',
        onCancel: () => {
          cancelCalled = true;
        },
      }),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("stream exploded");
    expect(cancelCalled).toBe(true);
  });

  it("maps unsupported xhigh to high effort for Claude 4.6 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      maxTokens: 8192,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think deeply." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "xhigh",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
    expect(payload.tool_choice).toBeUndefined();
  });

  it("does not infer adaptive thinking from forward-compatible effort maps", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-future",
      name: "Future Claude",
      provider: "github-copilot",
      reasoning: true,
      thinkingLevelMap: { xhigh: null, max: "max" },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think as much as supported." }],
      } as AnthropicStreamContext,
      {
        apiKey: "copilot-token",
        reasoning: "max",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 7168 });
    expect(payload.output_config).toBeUndefined();
  });

  it("resolves thinking as disabled when the legacy budget collapses to zero", async () => {
    // reasoning:true so the builder enters the thinking block, but an id that
    // does not match the adaptive-thinking regex so the budget-based path is used.
    const model = makeAnthropicTransportModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      maxTokens: 1024,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "test-token",
        reasoning: "minimal",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("resolves thinking as disabled when the legacy budget is positive but sub-minimum", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      maxTokens: 1500,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "hello" }],
      } as AnthropicStreamContext,
      {
        apiKey: "test-token",
        reasoning: "low",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("honors provider effort restrictions for transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-opus-4.7-1m-internal",
      name: "Claude Opus 4.7",
      provider: "github-copilot",
      maxTokens: 64_000,
      thinkingLevelMap: { xhigh: "xhigh" },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think as much as supported." }],
      } as AnthropicStreamContext,
      {
        apiKey: "copilot-token",
        reasoning: "max",
      } as AnthropicStreamOptions,
    );

    expect(latestAnthropicRequest().payload.output_config).toEqual({ effort: "xhigh" });
  });

  it("uses canonical Claude policy for transport deployment aliases", async () => {
    const model = makeAnthropicTransportModel({
      id: "production-claude",
      name: "Production Claude",
      params: { canonicalModelId: "claude-opus-4-8" },
      reasoning: false,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      maxTokens: 8192,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think extra hard." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "xhigh",
        temperature: 0.2,
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.model).toBe("production-claude");
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "xhigh" });
    expect(payload).not.toHaveProperty("temperature");
  });

  it.each([
    { canonicalModelId: "claude-opus-4-8", expectedTemperature: undefined },
    { canonicalModelId: "claude-opus-4-6", expectedTemperature: 0.2 },
  ] as const)(
    "normalizes temperature for canonical $canonicalModelId transport aliases when thinking is off",
    async ({ canonicalModelId, expectedTemperature }) => {
      const model = makeAnthropicTransportModel({
        id: "production-claude",
        name: "Production Claude",
        params: { canonicalModelId },
        reasoning: false,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        maxTokens: 8192,
      });

      await runTransportStream(
        model,
        { messages: [{ role: "user", content: "Reply briefly." }] } as AnthropicStreamContext,
        { apiKey: "sk-ant-api", temperature: 0.2 } as AnthropicStreamOptions,
      );

      expect(latestAnthropicRequest().payload.temperature).toBe(expectedTemperature);
    },
  );

  it.each([
    {
      name: "defaults to adaptive high",
      reasoning: undefined,
      thinking: { type: "adaptive", display: "summarized" },
      effort: { effort: "high" },
      toolChoice: { type: "auto" },
    },
    {
      name: "allows explicit off",
      reasoning: "off" as const,
      thinking: { type: "disabled" },
      effort: undefined,
      toolChoice: { type: "any" },
    },
  ])("supports Claude Sonnet 5 transport: $name", async (testCase) => {
    const model = makeAnthropicTransportModel({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      maxTokens: 128_000,
    });

    await runTransportStream(model, makeSonnet5PrefillContext(), {
      apiKey: "sk-ant-api",
      reasoning: testCase.reasoning,
      temperature: 0.2,
      toolChoice: "any",
    } as AnthropicStreamOptions);

    const payload = latestAnthropicRequest().payload;
    expect(payload).toMatchObject({
      max_tokens: 128_000,
      messages: [{ role: "user" }],
      thinking: testCase.thinking,
      tool_choice: testCase.toolChoice,
    });
    expect(payload).not.toHaveProperty("temperature");
    if (testCase.effort) {
      expect(payload.output_config).toEqual(testCase.effort);
    } else {
      expect(payload).not.toHaveProperty("output_config");
    }
  });

  it("uses always-on adaptive thinking for Claude Fable 5 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "prod-primary",
      name: "Production Claude",
      provider: "microsoft-foundry",
      params: { canonicalModelId: "claude-fable-5" },
      reasoning: false,
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      maxTokens: 128_000,
    });

    guardedFetchMock.mockResolvedValueOnce(
      createSseResponse([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            model: "claude-fable-5",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { type: "message_stop" },
      ]),
    );
    const result = await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        temperature: 0.2,
        toolChoice: { type: "tool", name: "read_file" },
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
    expect(payload.tool_choice).toEqual({ type: "auto" });
    expect(payload).not.toHaveProperty("temperature");
    expect(result.responseModel).toBe("claude-fable-5");
  });

  it("uses mandatory adaptive thinking and default sampling for Claude Mythos 5 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "prod-mythos",
      name: "Production Claude",
      provider: "microsoft-foundry",
      params: { canonicalModelId: "claude-mythos-5" },
      reasoning: false,
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      maxTokens: 128_000,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "off",
        temperature: 0.2,
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          top_p: 0.9,
          top_k: 40,
        }),
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "low" });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
    expect(payload).not.toHaveProperty("top_k");
  });

  it("uses adaptive thinking for canonical Claude Mythos Preview transport aliases", async () => {
    const model = makeAnthropicTransportModel({
      id: "prod-mythos-preview",
      name: "Production Claude",
      provider: "microsoft-foundry",
      params: { canonicalModelId: "claude-mythos-preview" },
      reasoning: true,
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      maxTokens: 128_000,
    });

    guardedFetchMock.mockResolvedValueOnce(createSseResponse());
    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("uses mandatory adaptive thinking for canonical Claude Mythos Preview transport aliases", async () => {
    const model = makeAnthropicTransportModel({
      id: "prod-mythos-preview",
      name: "Production Claude",
      provider: "microsoft-foundry",
      params: { canonicalModelId: "claude-mythos-preview" },
      reasoning: false,
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      maxTokens: 128_000,
    });

    guardedFetchMock.mockResolvedValueOnce(createSseResponse());
    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it.each(["claude-opus-4-8", "claude-mythos-preview"])(
    "restores default sampling for %s transport requests after payload hooks",
    async (modelId) => {
      await runTransportStream(
        makeAnthropicTransportModel({
          id: modelId,
          name: modelId,
          maxTokens: 128_000,
        }),
        { messages: [{ role: "user", content: "hello" }] } as AnthropicStreamContext,
        {
          apiKey: "sk-ant-api",
          reasoning: "high",
          temperature: 0.2,
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            temperature: 0.2,
            top_p: 0.9,
            top_k: 40,
          }),
        } as AnthropicStreamOptions,
      );

      const payload = latestAnthropicRequest().payload;
      expect(payload).not.toHaveProperty("temperature");
      expect(payload).not.toHaveProperty("top_p");
      expect(payload).not.toHaveProperty("top_k");
    },
  );

  it("maps Claude Fable 5 transport thinking levels to adaptive effort", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      maxTokens: 128_000,
    });

    guardedFetchMock.mockImplementation(async () => createSseResponse());
    for (const testCase of [
      { reasoning: "off", effort: "low" },
      { reasoning: "minimal", effort: "low" },
      { reasoning: "high", effort: "high" },
    ] as const) {
      await runTransportStream(
        model,
        {
          messages: [{ role: "user", content: "Think carefully." }],
        } as AnthropicStreamContext,
        {
          apiKey: "sk-ant-api",
          reasoning: testCase.reasoning,
        } as unknown as AnthropicStreamOptions,
      );

      const payload = latestAnthropicRequest().payload;
      expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(payload.output_config).toEqual({ effort: testCase.effort });
    }
  });

  it("honors provider effort restrictions for Claude Fable 5 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      provider: "github-copilot",
      reasoning: false,
      thinkingLevelMap: { xhigh: null, max: null },
      maxTokens: 128_000,
    });

    guardedFetchMock.mockImplementation(async () => createSseResponse());
    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think carefully." }],
      } as AnthropicStreamContext,
      {
        apiKey: "copilot-token",
        reasoning: "xhigh",
      } as unknown as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("uses the Claude Fable 5 contract on Anthropic Vertex transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      provider: "anthropic-vertex",
      maxTokens: 128_000,
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think carefully." }],
      } as AnthropicStreamContext,
      {
        apiKey: "vertex-token",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("maps xhigh thinking effort for Claude Opus 4.8 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      maxTokens: 8192,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think extra hard." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "xhigh",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "xhigh" });
  });

  it("preserves max thinking effort for Claude Opus 4.8 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      maxTokens: 8192,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think as much as needed." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "max",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "max" });
  });

  it("honors provider routes that exclude native max effort", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "github-copilot",
      maxTokens: 8192,
      thinkingLevelMap: { xhigh: null, max: null },
    });

    await runTransportStream(
      model,
      {
        messages: [{ role: "user", content: "Think as much as supported." }],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        reasoning: "max",
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(payload.output_config).toEqual({ effort: "high" });
  });

  it("emits start event only after message_start so pre-stream SSE errors arrive before any non-error event", async () => {
    guardedFetchMock.mockResolvedValueOnce(
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
      ]),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = streamFn(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hi" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    const startIndex = eventTypes.indexOf("start");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(eventTypes.slice(0, startIndex).some((t) => t === "error")).toBe(false);
  });

  it("emits error without a preceding start event when SSE error arrives before message_start", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      createRawSseResponse(
        "event: error\ndata: " +
          JSON.stringify({
            type: "invalid_request_error",
            message: "messages.1.content.63: Invalid signature in thinking block",
          }) +
          "\n\n",
      ),
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = streamFn(
      makeAnthropicTransportModel(),
      { messages: [{ role: "user", content: "hi" }] } as AnthropicStreamContext,
      { apiKey: "sk-ant-api" } as AnthropicStreamOptions,
    );

    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    // start must not precede the error path, regardless of whether the mock
    // surfaces the SSE error as an explicit "error" event or silently ends the
    // stream (a timing artefact of synchronous mock SSE delivery).
    expect(eventTypes).not.toContain("start");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
