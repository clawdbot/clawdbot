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

function latestAnthropicRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return {
    init,
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

function makeAnthropicTransportModel(
  params: {
    id?: string;
    name?: string;
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
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
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
