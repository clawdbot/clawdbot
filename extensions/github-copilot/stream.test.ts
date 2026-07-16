// Github Copilot tests cover stream plugin behavior.
import type { Context } from "openclaw/plugin-sdk/llm";
import { buildCopilotIdeHeaders, COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
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
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": initiator,
    ...(hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

describe("wrapCopilotAnthropicStream", () => {
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
