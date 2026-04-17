import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const {
  anthropicCtorMock,
  anthropicMessagesStreamMock,
  buildGuardedModelFetchMock,
  guardedFetchMock,
} = vi.hoisted(() => ({
  anthropicCtorMock: vi.fn(),
  anthropicMessagesStreamMock: vi.fn(),
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicCtorMock,
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

function emptyEventStream(): AsyncIterable<Record<string, unknown>> {
  return (async function* () {})();
}

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    anthropicCtorMock.mockReset();
    anthropicMessagesStreamMock.mockReset();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    anthropicMessagesStreamMock.mockReturnValue(emptyEventStream());
    anthropicCtorMock.mockImplementation(function mockAnthropicClient() {
      return {
        messages: {
          stream: anthropicMessagesStreamMock,
        },
      };
    });
  });

  it("uses the guarded fetch transport for api-key Anthropic requests", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        headers: { "X-Provider": "anthropic" },
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
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
          headers: { "X-Call": "1" },
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ant-api",
        baseURL: "https://api.anthropic.com",
        fetch: guardedFetchMock,
        defaultHeaders: expect.objectContaining({
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "X-Provider": "anthropic",
          "X-Call": "1",
        }),
      }),
    );
    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        stream: true,
      }),
      undefined,
    );
  });

  it("ignores non-positive runtime maxTokens overrides and falls back to the model limit", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
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
          maxTokens: 0,
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        stream: true,
      }),
      undefined,
    );
  });

  it("ignores fractional runtime maxTokens overrides that floor to zero", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
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
          maxTokens: 0.5,
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        stream: true,
      }),
      undefined,
    );
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
    expect(anthropicMessagesStreamMock).not.toHaveBeenCalled();
  });

  it("preserves Anthropic OAuth identity and tool-name remapping with transport overrides", async () => {
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { path: "/tmp/a" },
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })(),
    );
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );
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

    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: "sk-ant-oat-example",
        fetch: guardedFetchMock,
        defaultHeaders: expect.objectContaining({
          "x-app": "cli",
          "user-agent": expect.stringContaining("claude-cli/"),
        }),
      }),
    );
    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
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
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );
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

    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
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
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
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
          messages: [{ role: "user", content: "Think deeply." }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          reasoning: "xhigh",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: "adaptive" },
        output_config: { effort: "max" },
      }),
      undefined,
    );
  });

  it("maps xhigh thinking effort for Claude Opus 4.7 transport runs", async () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
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
          messages: [{ role: "user", content: "Think extra hard." }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          reasoning: "xhigh",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      }),
      undefined,
    );
  });
});
