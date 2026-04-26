import { buildCopilotDynamicHeaders } from "openclaw/plugin-sdk/provider-stream-shared";
import { describe, expect, it, vi } from "vitest";
import {
  wrapCopilotAnthropicStream,
  wrapCopilotOpenAIResponsesStream,
  wrapCopilotProviderStream,
} from "./stream.js";

function requireStreamFn(streamFn: ReturnType<typeof wrapCopilotProviderStream>) {
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("expected stream fn");
  }
  return streamFn;
}

describe("wrapCopilotAnthropicStream", () => {
  it("adds Copilot headers and Anthropic cache markers for Claude payloads", async () => {
    const payloads: Array<{
      messages: Array<Record<string, unknown>>;
    }> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "assistant",
            content: [{ type: "thinking", text: "draft", cache_control: { type: "ephemeral" } }],
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
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const context = { messages };
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      messages,
      hasImages: true,
    });

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
    expect(baseStreamFn.mock.calls[0]?.[2]).toMatchObject({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
    });
    expect(payloads[0]?.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [{ type: "thinking", text: "draft" }],
      },
    ]);
  });

  it("leaves non-Anthropic Copilot models untouched", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const options = { headers: { Existing: "1" } };

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-4.1",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      options as never,
    );

    expect(baseStreamFn).toHaveBeenCalledWith(expect.anything(), expect.anything(), options);
  });

  it("adds Copilot headers, preserves reasoning IDs, and rewrites message IDs before payload send", () => {
    const reasoningId = Buffer.from(`reasoning-${"x".repeat(24)}`).toString("base64");
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { id: reasoningId, type: "reasoning" },
          { id: messageId, type: "message" },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      messages,
      hasImages: true,
    });

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    expect(baseStreamFn.mock.calls[0]?.[2]).toMatchObject({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
    });
    expect(payloads[0]?.input[0]?.id).toBe(reasoningId);
    expect(payloads[0]?.input[1]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
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

    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));

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
