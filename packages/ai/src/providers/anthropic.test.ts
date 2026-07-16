// Anthropic provider tests cover stream events, tools, and message mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model, Tool } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

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
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
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

function makeSonnet5PrefillContext(): Context {
  return {
    messages: [
      { role: "user", content: "Return JSON.", timestamp: 0 },
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
  };
}

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("keeps Cloudflare AI Gateway upstream provider auth on the Anthropic API key", async () => {
    // Prove the Cloudflare client receives the host-built model fetch.
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
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
      fetch?: unknown;
    };

    expect(config.apiKey).toBe("sk-ant-provider");
    expect(config.authToken).toBeNull();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
    expect(config.fetch).toBe(hostFetch);
  });

  it("uses bearer auth for Microsoft Foundry Anthropic requests", async () => {
    const model = makeAnthropicModel({
      provider: "microsoft-foundry",
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      authHeader: true,
      headers: {
        "api-key": "stale-foundry-key",
        "x-api-key": "stale-resource-key",
      },
    });
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "entra-access-token",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
      defaultHeaders?: Record<string, string | null>;
    };

    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBe("entra-access-token");
    expect(config.defaultHeaders?.Authorization).toBeUndefined();
    expect(config.defaultHeaders?.["api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
  });

  it("keeps sentinel-backed Foundry Authorization headers on bearer routing", async () => {
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    configureAiTransportHost({
      buildModelFetch: () => async () => new Response(null, { status: 500 }),
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "Bearer entra-access-token"),
    });
    const model = makeAnthropicModel({
      provider: "microsoft-foundry",
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      headers: { Authorization: sentinel },
    });

    streamAnthropic(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      {
        apiKey: sentinel,
      },
    );

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
    };
    expect(config.apiKey).toBeNull();
    expect(config.authToken).toBe(sentinel);
  });

  it("keeps Microsoft Foundry API-key profiles on Anthropic API key auth", async () => {
    const model = makeAnthropicModel({
      provider: "microsoft-foundry",
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      headers: { "api-key": "foundry-resource-key" },
    });
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "foundry-resource-key",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
    };

    expect(config.apiKey).toBe("foundry-resource-key");
    expect(config.authToken).toBeNull();
  });

  it("puts Claude subscription billing identity first for OAuth requests", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
      {
        apiKey: "sk-ant-oat01-test-token",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { system?: unknown }).system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.75; cc_entrypoint=sdk-cli;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("keeps aggregate cache billing buckets out of the context total", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

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
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.usage.totalTokens).toBe(927_907);
    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("uses complete final usage when message-start prompt buckets are zero placeholders", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 148_874,
      totalTokens: 163_978,
    });
  });

  it("does not treat zero start placeholders as complete final prompt usage", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
  });

  it("uses accumulated prompt buckets when the final usage update is partial", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel(),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 149_374,
      totalTokens: 164_478,
    });
  });

  it("preserves valid message-start billing buckets when a sibling is malformed", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel(),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.usage).toMatchObject({
      input: 12,
      output: 15_104,
      cacheRead: 0,
      cacheWrite: 500,
      totalTokens: 15_616,
    });
    expect(result.usage.contextUsage).toEqual({ state: "unavailable" });
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
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
      }),
      {
        messages: [
          { role: "user", content: "hello", timestamp: 0 },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-fable-5",
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
                thinking: "",
                thinkingSignature: "sig_omitted",
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

    const result = await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(JSON.stringify(assistantMessage?.content)).not.toContain("reasoning_content");
    expect(assistantMessage?.content).toEqual([
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
    expect(result.responseModel).toBe("claude-fable-5");
  });

  it.each([
    {
      label: "omitted",
      thinkingEnabled: undefined,
      expectedThinking: undefined,
      visibleText: undefined,
      expectedContent: [{ type: "text", text: "[assistant reasoning omitted]" }],
    },
    {
      label: "explicitly disabled",
      thinkingEnabled: false,
      expectedThinking: { type: "disabled" },
      visibleText: "Visible answer.",
      expectedContent: [{ type: "text", text: "Visible answer." }],
    },
  ])(
    "omits completed-turn thinking when thinking is $label",
    async ({ thinkingEnabled, expectedThinking, visibleText, expectedContent }) => {
      let capturedPayload: unknown;
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
                  thinking: "private reasoning",
                  thinkingSignature: "sig_1",
                },
                {
                  type: "thinking",
                  thinking: "[Reasoning redacted]",
                  thinkingSignature: "opaque_1",
                  redacted: true,
                },
                ...(visibleText ? [{ type: "text" as const, text: visibleText }] : []),
              ],
            },
            { role: "user", content: "again", timestamp: 0 },
          ],
        },
        {
          apiKey: "sk-ant-provider",
          thinkingEnabled,
          onPayload: (payload) => {
            capturedPayload = payload;
            throw new Error("stop before network");
          },
        },
      );

      await stream.result();

      const payload = capturedPayload as {
        messages: Array<{ role: string; content: unknown[] }>;
        thinking?: unknown;
      };
      expect(payload.thinking).toEqual(expectedThinking);
      expect(payload.messages.find((message) => message.role === "assistant")?.content).toEqual(
        expectedContent,
      );
    },
  );

  it("preserves signed thinking for an active tool turn when new thinking is disabled", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [
          { role: "user", content: "look it up", timestamp: 0 },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
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
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: "sk-ant-provider",
        thinkingEnabled: false,
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(payload.messages.find((message) => message.role === "assistant")?.content).toEqual([
      { type: "thinking", thinking: "call lookup", signature: "sig_tool" },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it("preserves mixed text and image tool-result order", async () => {
    let capturedPayload: unknown;
    const imageData = Buffer.from("image").toString("base64");
    const stream = streamAnthropic(
      makeAnthropicModel({ input: ["text", "image"] }),
      {
        messages: [
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [
              { type: "text", text: "before image" },
              { type: "image", data: imageData, mimeType: "image/png" },
              {
                type: "resource" as const,
                resource: { uri: "https://example.com/data.json", text: '{"key":"value"}' },
              },
              { type: "text", text: "after image" },
            ],
            isError: false,
            timestamp: 0,
          },
        ],
      } as unknown as Context,
      {
        apiKey: "sk-ant-provider",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const userMessage = payload.messages.find((message) => message.role === "user");
    const toolResult = userMessage?.content.find((entry) => entry.type === "tool_result") as {
      content: unknown[];
    };

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
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t "],
    ["invalid-surrogate-only", String.fromCharCode(0xd83d)],
  ])("replaces %s error tool results with non-empty content", async (_label, text) => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({ provider: "github-copilot" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "github-copilot",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "toolUse",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text }],
            isError: true,
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: "copilot-token",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const userMessage = payload.messages.find((message) => message.role === "user");
    const toolResult = userMessage?.content.find((entry) => entry.type === "tool_result");
    expect(toolResult).toMatchObject({
      content: "[tool error with no output]",
      is_error: true,
    });
  });

  it.each([
    ["claude-fable-5", "Claude Fable 5", "anthropic", "sk-ant-provider"],
    ["claude-mythos-5", "Claude Mythos 5", "anthropic", "sk-ant-provider"],
    ["claude-mythos-5", "Claude Mythos 5", "anthropic-vertex", "vertex-token"],
    ["claude-sonnet-5", "Claude Sonnet 5", "anthropic", "sk-ant-provider"],
    ["claude-sonnet-5", "Claude Sonnet 5", "anthropic-vertex", "vertex-token"],
  ])("surfaces structured %s streaming refusals for %s", async (id, name, provider, apiKey) => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
                      category: "cyber",
                      explanation: "This request is not allowed.",
                    },
                  },
                  usage: { input_tokens: 3, output_tokens: 2 },
                },
                { type: "message_stop" },
              ]),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel({
        id,
        name,
        provider,
      }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey, client: client as never },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe(
      "Anthropic refusal (category: cyber): This request is not allowed.",
    );
    expect(result.usage).toMatchObject({ input: 3, output: 2 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: {
          provider,
          category: "cyber",
          explanation: "This request is not allowed.",
        },
      }),
    ]);
  });

  it("sends server-side fallback params for direct Fable API-key requests", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "sk-ant-provider",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );
    await stream.result();

    expect((capturedPayload as { fallbacks?: unknown }).fallbacks).toEqual([
      { model: "claude-opus-4-8" },
    ]);
    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      defaultHeaders?: Record<string, string>;
    };
    expect(config.defaultHeaders?.["anthropic-beta"]).toContain("server-side-fallback-2026-06-01");
  });

  it.each([
    { label: "OAuth tokens", overrides: {}, apiKey: "sk-ant-oat01-token" },
    {
      label: "custom proxy endpoints",
      overrides: { baseUrl: "https://proxy.example.com/v1" },
      apiKey: "sk-ant-provider",
    },
    {
      label: "Anthropic Vertex models",
      overrides: { provider: "anthropic-vertex" },
      apiKey: "vertex-token",
    },
    {
      label: "non-Fable models",
      overrides: { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      apiKey: "sk-ant-provider",
    },
  ])("omits server-side fallback params for $label", async ({ overrides, apiKey }) => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5", ...overrides }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey,
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );
    await stream.result();

    expect((capturedPayload as { fallbacks?: unknown }).fallbacks).toBeUndefined();
  });

  it("rebuilds Fable output at a mid-stream server-side fallback boundary", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: {
                    id: "msg_fallback",
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
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "text_delta", text: "partial " },
                },
                { type: "content_block_stop", index: 1 },
                {
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
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    // Pre-boundary thinking/tool blocks must not replay or execute; text is
    // the continuation prefix the fallback model built on.
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
    expect(eventTypes).not.toContain("thinking_start");
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
    // Fallback-served turns bill at the serving model's rates, not Fable's:
    // 5 input tokens at $5/MTok plus 9 output tokens at $25/MTok.
    expect(result.usage.cost.input).toBeCloseTo(0.000025, 10);
    expect(result.usage.cost.output).toBeCloseTo(0.000225, 10);
    expect(result.usage.cost.total).toBeCloseTo(0.00025, 10);
  });

  it("records a pre-output server-side fallback and keeps the continuation", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: {
                    id: "msg_fallback",
                    // Pre-output declines: message_start names the fallback model.
                    model: "claude-opus-4-8",
                    usage: { input_tokens: 5, output_tokens: 0 },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "fallback",
                    from: { model: "claude-fable-5" },
                    to: { model: "claude-opus-4-8" },
                  },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "text_delta", text: "Hi!" },
                },
                { type: "content_block_stop", index: 1 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { input_tokens: 5, output_tokens: 2 },
                },
                { type: "message_stop" },
              ]),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Hi!" }]);
    expect(result.responseModel).toBe("claude-opus-4-8");
    expect(result.diagnostics).toEqual([expect.objectContaining({ type: "provider_fallback" })]);
  });

  it("routes interleaved active content blocks by their event indexes", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: { id: "msg_interleaved", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text" },
                },
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "text" },
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
            ),
        })),
      },
    };

    const result = await streamAnthropic(
      makeAnthropicModel(),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    ).result();

    expect(result.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("discards buffered Fable output when the stream fails before terminal status", async () => {
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
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
            ),
        })),
      },
    };
    const stream = streamAnthropic(
      makeAnthropicModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-provider", client: client as never },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toContain("ended before message_stop");
  });

  it("strips Fable thinking when replay targets Anthropic Vertex", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({
        provider: "anthropic-vertex",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
      }),
      {
        messages: [
          { role: "user", content: "hello", timestamp: 0 },
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
                thinking: "model-bound thought",
                thinkingSignature: "sig_model_bound",
              },
              { type: "text", text: "visible answer" },
            ],
          },
          { role: "user", content: "continue", timestamp: 0 },
        ],
      } as Context,
      {
        apiKey: "vertex-token",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toEqual([{ type: "text", text: "visible answer" }]);
    expect(JSON.stringify(assistantMessage)).not.toContain("sig_model_bound");
  });

  it.each([
    { reasoning: "xhigh", expectedEffort: "high" },
    { reasoning: "max", expectedEffort: "max" },
  ] as const)("maps Claude 4.6 $reasoning effort", async ({ reasoning, expectedEffort }) => {
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
        reasoning,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
      effort: expectedEffort,
    });
  });

  it.each([
    {
      id: "claude-opus-4.6-1m",
      reasoning: "xhigh",
      thinkingLevelMap: { xhigh: null, max: null },
      expectedEffort: "high",
    },
    {
      id: "claude-opus-4.7-1m-internal",
      reasoning: "max",
      thinkingLevelMap: { xhigh: "xhigh" },
      expectedEffort: "xhigh",
    },
  ] as const)(
    "honors proxy effort restrictions for $id",
    async ({ id, reasoning, thinkingLevelMap, expectedEffort }) => {
      let capturedPayload: unknown;
      const stream = streamSimpleAnthropic(
        makeAnthropicModel({
          id,
          provider: "github-copilot",
          thinkingLevelMap,
        }),
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        {
          apiKey: "copilot-token",
          reasoning,
          onPayload: (payload) => {
            capturedPayload = payload;
          },
        },
      );

      await stream.result();

      expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
        effort: expectedEffort,
      });
    },
  );

  it("uses always-on adaptive thinking for Claude Fable 5", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "prod-primary",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-fable-5" },
        reasoning: false,
        baseUrl: "https://example.services.ai.azure.com/anthropic",
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        temperature: 0.2,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    expect(capturedPayload).not.toHaveProperty("temperature");
  });

  it("uses mandatory adaptive thinking and default sampling for Claude Mythos 5", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "prod-mythos",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-mythos-5" },
        reasoning: false,
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "off",
        temperature: 0.2,
        onPayload: (payload) => {
          capturedPayload = {
            ...(payload as Record<string, unknown>),
            top_p: 0.9,
            top_k: 40,
          };
          return capturedPayload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
    expect(capturedPayload).not.toHaveProperty("temperature");
    expect(capturedPayload).not.toHaveProperty("top_p");
    expect(capturedPayload).not.toHaveProperty("top_k");
  });

  it("preserves native max effort for Claude Mythos Preview", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-mythos-preview",
        name: "Claude Mythos Preview",
        reasoning: true,
        maxTokens: 128_000,
        thinkingLevelMap: { max: "max" },
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
      effort: "max",
    });
  });

  it("uses mandatory adaptive thinking for Foundry Mythos Preview", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "prod-mythos-preview",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-mythos-preview" },
        reasoning: false,
      }),
      {
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

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
  });

  it("uses adaptive high effort for Foundry Mythos Preview without native max metadata", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "prod-mythos-preview",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-mythos-preview" },
        reasoning: true,
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
  });

  it("does not infer adaptive thinking from forward-compatible effort maps", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-future",
        name: "Future Claude",
        provider: "github-copilot",
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: "max" },
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "copilot-token",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "enabled" },
    });
    expect((capturedPayload as { output_config?: unknown }).output_config).toBeUndefined();
  });

  it("resolves thinking as disabled when the legacy budget collapses below 1024", async () => {
    // reasoning:true so the builder enters the thinking block, but an id that
    // does not match the adaptive-thinking regex so the budget-based path is used.
    const model = makeAnthropicModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      maxTokens: 1024,
    });
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "sk-ant-provider",
        reasoning: "minimal",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );
    await stream.result();
    expect((capturedPayload as { thinking?: unknown }).thinking).toEqual({ type: "disabled" });
  });

  it("resolves thinking as disabled when the legacy budget is positive but sub-minimum", async () => {
    const model = makeAnthropicModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      maxTokens: 1500,
    });
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "sk-ant-provider",
        reasoning: "low",
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop before network");
        },
      },
    );
    await stream.result();
    expect((capturedPayload as { thinking?: unknown }).thinking).toEqual({ type: "disabled" });
  });

  it.each([
    { budgetTokens: 512, maxTokens: 8192 },
    { budgetTokens: 1024, maxTokens: 1024 },
  ])(
    "normalizes raw manual thinking budget $budgetTokens below max $maxTokens",
    async ({ budgetTokens, maxTokens }) => {
      const model = makeAnthropicModel({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        maxTokens: 8192,
      });
      let capturedPayload: unknown;
      const stream = streamAnthropic(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
        },
        {
          apiKey: "sk-ant-provider",
          maxTokens,
          temperature: 0.2,
          thinkingEnabled: true,
          thinkingBudgetTokens: budgetTokens,
          toolChoice: "any",
          onPayload: (payload) => {
            capturedPayload = payload;
            throw new Error("stop before network");
          },
        },
      );

      await stream.result();

      expect(capturedPayload).toMatchObject({
        thinking: { type: "disabled" },
        temperature: 0.2,
        tool_choice: { type: "any" },
      });
    },
  );

  it.each(["claude-opus-4-8", "claude-mythos-preview"])(
    "restores default sampling for %s after payload hooks",
    async (modelId) => {
      let capturedPayload: unknown;
      const stream = streamSimpleAnthropic(
        makeAnthropicModel({
          id: modelId,
          name: modelId,
          maxTokens: 128_000,
        }),
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        {
          apiKey: "sk-ant-provider",
          reasoning: "high",
          temperature: 0.2,
          onPayload: (payload) => {
            capturedPayload = {
              ...(payload as Record<string, unknown>),
              temperature: 0.2,
              top_p: 0.9,
              top_k: 40,
            };
            return capturedPayload;
          },
        },
      );

      await stream.result();

      expect(capturedPayload).not.toHaveProperty("temperature");
      expect(capturedPayload).not.toHaveProperty("top_p");
      expect(capturedPayload).not.toHaveProperty("top_k");
    },
  );

  it.each([
    {
      id: "prod-primary",
      name: "Claude Fable 5",
      params: undefined,
    },
  ])("does not infer the Fable contract from noncanonical metadata", async (overrides) => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        ...overrides,
        reasoning: false,
      }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "sk-ant-provider",
        temperature: 0.2,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({ temperature: 0.2 });
    expect(capturedPayload).not.toHaveProperty("thinking");
  });

  it("uses canonical Claude policy for deployment aliases", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "production-claude",
        name: "Production Claude",
        params: { canonicalModelId: "claude-opus-4-8" },
        reasoning: false,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "sk-ant-provider",
        reasoning: "xhigh",
        temperature: 0.2,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      model: "production-claude",
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    });
    expect(capturedPayload).not.toHaveProperty("temperature");
  });

  it.each([
    { canonicalModelId: "claude-opus-4-8", expectedTemperature: undefined },
    { canonicalModelId: "claude-opus-4-6", expectedTemperature: 0.2 },
  ] as const)(
    "normalizes temperature for canonical $canonicalModelId aliases when thinking is off",
    async ({ canonicalModelId, expectedTemperature }) => {
      let capturedPayload: unknown;
      const stream = streamSimpleAnthropic(
        makeAnthropicModel({
          id: "production-claude",
          params: { canonicalModelId },
          reasoning: false,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        {
          apiKey: "sk-ant-provider",
          temperature: 0.2,
          onPayload: (payload) => {
            capturedPayload = payload;
          },
        },
      );

      await stream.result();

      expect((capturedPayload as { temperature?: number }).temperature).toBe(expectedTemperature);
    },
  );

  it("normalizes forced Fable tool choice to auto", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
      }),
      {
        messages: [{ role: "user", content: "Use a tool.", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        thinkingEnabled: true,
        effort: "high",
        toolChoice: "any",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      tool_choice: { type: "auto" },
    });
  });

  it("preserves Claude Fable 5 high effort when catalog reasoning is false", async () => {
    const model = makeAnthropicModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      reasoning: false,
    });
    for (const testCase of [
      { reasoning: "off", effort: "low" },
      { reasoning: "high", effort: "high" },
      { reasoning: "xhigh", effort: "xhigh" },
    ] as const) {
      let capturedPayload: unknown;
      const stream = streamSimpleAnthropic(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        },
        {
          apiKey: "sk-ant-provider",
          reasoning: testCase.reasoning,
          onPayload: (payload: unknown) => {
            capturedPayload = payload;
          },
        } as unknown as Parameters<typeof streamSimpleAnthropic>[2],
      );

      await stream.result();

      expect(capturedPayload).toMatchObject({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: testCase.effort },
      });
    }
  });

  it("honors provider effort restrictions for Claude Fable 5", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "github-copilot",
        reasoning: false,
        thinkingLevelMap: { xhigh: null, max: null },
      }),
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "copilot-token",
        reasoning: "xhigh",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it("uses the Claude Fable 5 contract on Anthropic Vertex", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic-vertex",
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "vertex-token",
        reasoning: "high",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
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

  it("skips unreadable Anthropic provider tools while preserving healthy siblings", async () => {
    let capturedPayload: unknown;
    const unreadableTool = {
      name: "unreadable_plugin_tool",
      description: "unreadable schema",
      get parameters(): Tool["parameters"] {
        throw new Error("fuzz parameters getter exploded");
      },
    } as Tool;
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          unreadableTool,
          {
            name: "invalid_required_tool",
            description: "invalid required",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: "query",
            },
          } as unknown as Tool,
          {
            name: "healthy_tool",
            description: "healthy schema",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          } as Tool,
        ],
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
    const payload = capturedPayload as {
      tools?: Array<{ name?: string; input_schema?: unknown }>;
    };

    expect(result.stopReason).toBe("error");
    expect(payload.tools?.map((tool) => tool.name)).toEqual(["healthy_tool"]);
    expect(payload.tools?.[0]?.input_schema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("fails locally when a pinned Anthropic provider tool is skipped", async () => {
    const unreadableTool = {
      name: "unreadable_plugin_tool",
      description: "unreadable schema",
      get parameters(): Tool["parameters"] {
        throw new Error("fuzz parameters getter exploded");
      },
    } as Tool;
    const onPayload = vi.fn();
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          unreadableTool,
          {
            name: "healthy_tool",
            description: "healthy schema",
            parameters: { type: "object", properties: {} },
          } as Tool,
        ],
      },
      {
        apiKey: "sk-ant-provider",
        toolChoice: { type: "tool", name: "unreadable_plugin_tool" },
        onPayload,
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool_choice requested unavailable tool "unreadable_plugin_tool"',
    );
    expect(onPayload).not.toHaveBeenCalled();
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

  it("anchors the message cache breakpoint on the last stable user turn, skipping a trailing runtime-context carrier", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel(),
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "stable question", timestamp: 0 },
          {
            role: "user",
            content: "volatile current-turn metadata",
            timestamp: 1,
            runtimeContextCarrier: true,
          },
        ],
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
    const messages = (capturedPayload as { messages: { content: unknown }[] }).messages;
    // Deepest breakpoint anchors on the stable user turn (converted to a block
    // array with cache_control) so it stays a cacheable prefix next turn...
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "stable question", cache_control: { type: "ephemeral" } },
    ]);
    // ...and NOT on the trailing volatile carrier, which is left uncached.
    expect(messages[1]?.content).toBe("volatile current-turn metadata");
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
  ])("supports Claude Sonnet 5: $name", async ({ reasoning, thinking, effort, toolChoice }) => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        maxTokens: 128_000,
      }),
      makeSonnet5PrefillContext(),
      {
        apiKey: "sk-ant-provider",
        reasoning,
        temperature: 0.2,
        toolChoice: "any",
        onPayload: (payload) => {
          capturedPayload = payload as unknown as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      max_tokens: 128_000,
      messages: [{ role: "user" }],
      thinking,
      tool_choice: toolChoice,
    });
    expect(capturedPayload).not.toHaveProperty("temperature");
    if (effort) {
      expect(capturedPayload).toMatchObject({ output_config: effort });
    } else {
      expect(capturedPayload).not.toHaveProperty("output_config");
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
