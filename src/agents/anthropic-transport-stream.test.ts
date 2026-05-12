import type { Model } from "@earendil-works/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicMessagesModel = Model<"anthropic-messages">;
type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = Parameters<AnthropicStreamFn>[2];
type RequestTransportConfig = Parameters<typeof attachModelProviderRequestTransport>[1];

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
    maxTokens?: number;
    headers?: Record<string, string>;
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
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: params.maxTokens ?? 8192,
      ...(params.headers ? { headers: params.headers } : {}),
    } satisfies AnthropicMessagesModel,
    params.requestTransport ?? {
      proxy: {
        mode: "env-proxy",
      },
    },
  );
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
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    guardedFetchMock.mockResolvedValue(createSseResponse());
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
    const [url, init] = guardedFetchMock.mock.calls.at(0) ?? [];
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

    expect(guardedFetchMock.mock.calls.at(0)?.[0]).toBe("https://custom-proxy.example/v1/messages");
    expect(guardedFetchMock.mock.calls.at(0)?.[1]?.method).toBe("POST");
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

  it("fails locally when Anthropic maxTokens is non-positive after resolution", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
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
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
        } as Parameters<typeof streamFn>[2],
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
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(guardedFetchMock.mock.calls.at(0)?.[0]).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(guardedFetchMock.mock.calls.at(0)?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-example");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("user-agent")).toContain("claude-cli/");
    const firstCallParams = latestAnthropicRequest().payload;
    const system = requireArray(firstCallParams.system, "system");
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
      requireArray(firstCallParams.tools, "tools").some(
        (item) => requireRecord(item, "tool").name === "Read",
      ),
    ).toBe(true);
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
            name: "bad_plugin_tool",
            description: "missing schema",
            execute: async () => ({ content: [{ type: "text", text: "bad" }] }),
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
      const [[url, fetchOptions]] = guardedFetchMock.mock.calls as unknown as Array<
        [string, { method?: string }]
      >;
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

  it("drops empty text blocks from image tool results before Anthropic payloads", async () => {
    const imageData = Buffer.from("image").toString("base64");

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

  it("maps adaptive thinking effort for Claude 4.6 transport runs", async () => {
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
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "max" });
  });

  it("maps xhigh thinking effort for Claude Opus 4.7 transport runs", async () => {
    const model = makeAnthropicTransportModel({
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
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
      } as AnthropicStreamOptions,
    );

    const payload = latestAnthropicRequest().payload;
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "xhigh" });
  });
});
