// Github Copilot tests cover stream plugin behavior.
import type { Context } from "openclaw/plugin-sdk/llm";
import { buildCopilotIdeHeaders } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { COPILOT_RUNTIME_INTEGRATION_ID } from "./runtime-identity.js";
import { wrapCopilotAnthropicStream, wrapCopilotProviderStream } from "./stream.js";

function requireStreamFn(streamFn: ReturnType<typeof wrapCopilotProviderStream>) {
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("expected stream fn");
  }
  return streamFn;
}

function requireFirstStreamOptions(mock: ReturnType<typeof vi.fn>, label: string) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  const options = call[2];
  if (!options || typeof options !== "object") {
    throw new Error(`expected ${label} options`);
  }
  return options as { headers?: Record<string, unknown>; onPayload?: unknown };
}

function buildExpectedCopilotHeaders(
  initiator: "agent" | "user",
  hasImages: boolean,
): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_RUNTIME_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": initiator,
    ...(hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

describe("wrapCopilotAnthropicStream", () => {
  it("normalizes Copilot Claude wire tool IDs without mutating the persisted transcript", () => {
    const model = {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-sonnet-4.6",
    } as never;
    const sourceIds = [
      "toolu_native_123",
      "already-valid_id-456",
      "pipe|value",
      "dot.value",
      "colon:value",
      "slash/value",
      "space value",
      "functions.read:0",
      `toolu_${"x".repeat(80)}`,
    ];
    const messages = [
      { role: "user", content: "Use each tool" },
      {
        role: "assistant",
        provider: "github-copilot",
        api: "anthropic-messages",
        model: "claude-sonnet-4.6",
        content: [
          { type: "thinking", thinking: "private", thinkingSignature: "signature" },
          ...sourceIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
        ],
      },
      ...sourceIds.map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `result for ${id}` }],
      })),
    ] as Context["messages"];
    const persistedTranscript = structuredClone(messages);
    let observedPayload: { messages: Array<{ role: string; content: unknown }> } | undefined;
    const baseStreamFn = vi.fn((streamModel, context, options) => {
      const payload = {
        messages: context.messages.map((message) => {
          if (message.role === "toolResult") {
            return {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: message.toolCallId,
                  content: message.content,
                },
              ],
            };
          }
          if (message.role !== "assistant") {
            return { role: message.role, content: message.content };
          }
          return {
            role: "assistant",
            content: message.content.map((block) =>
              block.type === "toolCall"
                ? { type: "tool_use", id: block.id, name: block.name, input: block.arguments }
                : block,
            ),
          };
        }),
      };
      options?.onPayload?.(payload, streamModel);
      observedPayload = payload;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });

    void requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn))(model, { messages }, {});

    const outbound = observedPayload?.messages ?? [];
    const assistant = outbound.find((message) => message.role === "assistant");
    const assistantBlocks = Array.isArray(assistant?.content) ? assistant.content : [];
    const outboundIds = assistantBlocks
      .filter((block): block is { type: "tool_use"; id: string } => block.type === "tool_use")
      .map((block) => block.id);
    const resultIds = outbound.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter(
              (block): block is { type: "tool_result"; tool_use_id: string } =>
                block.type === "tool_result",
            )
            .map((block) => block.tool_use_id)
        : [],
    );

    expect(outboundIds).toEqual([
      "toolu_native_123",
      "already-valid_id-456",
      "pipe_value",
      "dot_value",
      "colon_value",
      "slash_value",
      "space_value",
      "functions_read_0",
      `toolu_${"x".repeat(58)}`,
    ]);
    expect(resultIds).toEqual(outboundIds);
    expect(assistantBlocks.some((block) => block.type === "thinking")).toBe(false);
    expect(messages).toEqual(persistedTranscript);
  });

  it.each(["sync", "async", "sync in-place", "async in-place"] as const)(
    "normalizes Copilot Claude payloads returned by a %s caller hook",
    async (hookType) => {
      let returnedPayload: unknown;
      const baseStreamFn = vi.fn(async (model, _context, options) => {
        const initialPayload = { messages: [{ role: "user", content: "initial request" }] };
        const replacement = await options?.onPayload?.(initialPayload, model);
        returnedPayload = replacement ?? initialPayload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      });
      const replacement = {
        messages: [
          { role: "system", content: "replacement system prompt" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "tool_use", id: "functions.read:0", name: "read", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "functions.read:0", content: "done" }],
          },
        ],
      };

      await requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn))(
        { provider: "github-copilot", api: "anthropic-messages", id: "claude-sonnet-4.6" } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          onPayload: (payload) => {
            const inPlace = hookType.endsWith("in-place");
            if (inPlace && payload && typeof payload === "object") {
              Object.assign(payload, replacement);
            }
            const result = inPlace ? undefined : replacement;
            return hookType.startsWith("async") ? Promise.resolve(result) : result;
          },
        },
      );

      expect(returnedPayload).toEqual({
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "replacement system prompt",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "functions_read_0", name: "read", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "functions_read_0", content: "done" }],
          },
        ],
      });
    },
  );

  it("adds Copilot headers, strips thinking replay, and marks cache for Claude payloads", () => {
    const payloads: Array<{
      messages: Array<Record<string, unknown>>;
    }> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "draft", cache_control: { type: "ephemeral" } },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "visible reply" },
            ],
          },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Context["messages"];
    const context = { messages };
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("user", true);
    expect(expectedCopilotHeaders["Accept-Encoding"]).toBe("identity");

    void wrapped(
      {
        provider: "github-copilot",
        api: "anthropic-messages",
        id: "claude-sonnet-4.6",
      } as never,
      context as never,
      {
        headers: { "X-Test": "1" },
      },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Anthropic stream");
    if (!options?.onPayload) {
      throw new Error("expected Copilot Anthropic stream options");
    }
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
      onPayload: options.onPayload,
    });
    expect(payloads[0]?.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible reply" }],
      },
    ]);
  });

  it("keeps a non-empty assistant turn when Copilot replay only contains thinking", () => {
    const payloads: Array<{
      messages: Array<Record<string, unknown>>;
    }> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "user", content: "use the tool result" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "redacted_thinking", data: "opaque" },
            ],
          },
          { role: "user", content: [{ type: "tool_result", content: "done" }] },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    void wrapped(
      {
        provider: "github-copilot",
        api: "anthropic-messages",
        id: "claude-haiku-4.5",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      { role: "user", content: "use the tool result" },
      { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
      { role: "user", content: [{ type: "tool_result", content: "done" }] },
    ]);
  });

  it("leaves non-Anthropic Copilot models untouched", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-4.1",
    } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const options = { headers: { Existing: "1" } };

    void wrapped(model, context, options as never);

    expect(baseStreamFn.mock.calls).toEqual([[model, context, options]]);
  });

  it.each([
    { provider: "anthropic", id: "claude-sonnet-4-6", toolId: "toolu_native_123" },
    { provider: "kimi", id: "k2p5", toolId: "functions.read:0" },
  ])("does not patch unrelated $provider Anthropic streams", (model) => {
    const payload = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: model.toolId }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: model.toolId }] },
      ],
    };
    const baseStreamFn = vi.fn((streamModel, _context, streamOptions) => {
      streamOptions?.onPayload?.(payload, streamModel);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const streamModel = {
      provider: model.provider,
      id: model.id,
      api: "anthropic-messages",
    } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const options = { headers: { Existing: "1" }, onPayload: vi.fn() };

    void wrapped(streamModel, context, options as never);

    expect(baseStreamFn.mock.calls).toEqual([[streamModel, context, options]]);
    expect(payload.messages[0]?.content[0]).toEqual({ type: "tool_use", id: model.toolId });
    expect(payload.messages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: model.toolId,
    });
  });

  it("adds Copilot headers, sanitizes reasoning replay, and rewrites message IDs before payload send", () => {
    const reasoningId = Buffer.from(`reasoning-${"x".repeat(24)}`).toString("base64");
    const overlongReasoningId = `5PX6gLHXT5wE+Y2tPmUV4gn+${"B".repeat(384)}`;
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { id: reasoningId, type: "reasoning", encrypted_content: "valid-encrypted-payload" },
          { type: "reasoning", encrypted_content: "idless-encrypted-payload", summary: [] },
          {
            id: overlongReasoningId,
            type: "reasoning",
            encrypted_content: "invalid-encrypted-payload",
            summary: [],
          },
          { id: messageId, type: "message" },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotProviderStream({ streamFn: baseStreamFn } as never));
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Context["messages"];
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("agent", true);

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Responses stream");
    if (!options?.onPayload) {
      throw new Error("expected Copilot Responses stream options");
    }
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
      onPayload: options.onPayload,
    });
    expect(payloads[0]?.input[0]?.id).toBe(reasoningId);
    expect(payloads[0]?.input.map((item) => item.type)).toEqual([
      "reasoning",
      "reasoning",
      "message",
    ]);
    expect(payloads[0]?.input[1]?.id).toBeUndefined();
    expect(payloads[0]?.input[2]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(payloads[0]?.input[0]).not.toHaveProperty("encrypted_content");
    expect(payloads[0]?.input[1]).not.toHaveProperty("encrypted_content");
  });

  it("rewrites Copilot Responses IDs returned by an existing payload hook", async () => {
    const connectionBoundId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    let returnedPayload: unknown;
    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      returnedPayload = await options?.onPayload?.({ input: [] }, _model);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotProviderStream({ streamFn: baseStreamFn } as never));

    await wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {
        onPayload: () => ({ input: [{ id: connectionBoundId, type: "message" }] }),
      } as never,
    );

    expect((returnedPayload as { input: Array<Record<string, unknown>> }).input[0]?.id).toMatch(
      /^msg_[a-f0-9]{16}$/,
    );
  });

  it("adds Copilot headers for Chat Completions models", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotProviderStream({ streamFn: baseStreamFn } as never));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      },
    ] as Context["messages"];
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("user", true);

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-completions",
        id: "gemini-3.1-pro-preview",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Chat Completions stream");
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
    });
  });

  it("adapts provider stream context without changing wrapper behavior", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);

    const wrapped = requireStreamFn(
      wrapCopilotProviderStream({
        streamFn: baseStreamFn,
      } as never),
    );

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-4.1",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(
      wrapCopilotProviderStream({
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
