import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession reply tags", () => {
  it("carries reply_to_current across tag-only block chunks", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "[[reply_to_current]]\nHello",
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]\nHello" }],
    } as AssistantMessage;
    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.text).toBe("Hello");
    expect(payload?.replyToCurrent).toBe(true);
    expect(payload?.replyToTag).toBe(true);
  });

  it("flushes trailing directive tails on stream end", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello [[" },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello [[" }],
    } as AssistantMessage;
    handler?.({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Hello");
    expect(onBlockReply.mock.calls[1]?.[0]?.text).toBe("[[");
  });
});
