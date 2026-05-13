import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession reply tags", () => {
  type ReplyPayload = { text?: string; replyToCurrent?: boolean; replyToTag?: boolean };

  function replyPayloadAt(mock: ReturnType<typeof vi.fn>, index: number): ReplyPayload {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected reply payload at index ${index}`);
    }
    return call[0] as ReplyPayload;
  }

  function replyTexts(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map(([payload]) => (payload as ReplyPayload).text ?? "");
  }

  function lastReplyPayload(mock: ReturnType<typeof vi.fn>): ReplyPayload {
    return replyPayloadAt(mock, mock.mock.calls.length - 1);
  }

  function createBlockReplyHarness() {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    return { emit, onBlockReply };
  }

  it("carries reply_to_current across tag-only block chunks", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_current]]\nHello" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]\nHello" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe("Hello");
    expect(payload.replyToCurrent).toBe(true);
    expect(payload.replyToTag).toBe(true);
  });

  it("flushes trailing directive tails on stream end", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello [[" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello [[" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(replyTexts(onBlockReply)).toEqual(["Hello", "[["]);
  });

  it("streams partial replies past reply_to tags split across chunks", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to:1897" });
    emitAssistantTextDelta({ emit, delta: "]] Hello" });
    emitAssistantTextDelta({ emit, delta: " world" });
    emitAssistantTextEnd({ emit });

    expect(lastReplyPayload(onPartialReply).text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });
});
