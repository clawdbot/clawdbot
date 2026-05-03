import type { Model } from "@mariozechner/pi-ai";
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
    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-api",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "X-Provider": "anthropic",
          "X-Call": "1",
        }),
      }),
    );
    expect(latestAnthropicRequest().payload).toMatchObject({
      model: "claude-sonnet-4-6",
      stream: true,
    });
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14",
    );
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

    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://custom-proxy.example/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
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

    expect(latestAnthropicRequest().payload).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      stream: true,
    });
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

    expect(latestAnthropicRequest().payload).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      stream: true,
    });
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

    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk-ant-oat-example",
          "x-app": "cli",
          "user-agent": expect.stringContaining("claude-cli/"),
        }),
      }),
    );
    const firstCallParams = latestAnthropicRequest().payload;
    expect(firstCallParams.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        }),
        expect.objectContaining({
          text: "Follow policy.",
        }),
      ]),
    );
    expect(firstCallParams.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Read" })]),
    );
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "read" })]),
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

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "checking",
        thinkingSignature: "sig_2",
      }),
      { type: "text", text: "NO_REPLY" },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text_delta", delta: "NO_REPLY" }),
        expect.objectContaining({ type: "text_end", content: "NO_REPLY" }),
      ]),
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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text_start" }),
        expect.objectContaining({ type: "text_delta", delta: "你好" }),
        expect.objectContaining({ type: "text_end", content: "你好" }),
      ]),
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

    expect(latestAnthropicRequest().payload.tools).toEqual([
      expect.objectContaining({
        name: "good_plugin_tool",
        input_schema: expect.objectContaining({
          properties: {
            query: { type: "string" },
          },
        }),
      }),
    ]);
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
    expect(firstCallParams.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              name: "lookup",
              input: {},
            }),
          ]),
        }),
      ]),
    );
  });

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

    expect(latestAnthropicRequest().payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "(no output)",
              is_error: false,
            }),
          ]),
        }),
      ]),
    );
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

    expect(latestAnthropicRequest().payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                { type: "text", text: "(see attached image)" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: imageData,
                  },
                },
              ],
              is_error: false,
            }),
          ]),
        }),
      ]),
    );
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

    expect(latestAnthropicRequest().payload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
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

    expect(latestAnthropicRequest().payload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    });
  });
});
