// Reply-tag tests cover streaming directive parsing for reply_to markers across
// block replies and partial reply chunks.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession reply tags", () => {
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
    // Small chunk sizes force directive-only and text chunks through the block
    // reply path where reply metadata must be preserved.
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedAgentSession({
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

    return { emit, onBlockReply, subscription };
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

  it.each([
    {
      name: "literal brackets",
      text: "Hello [[",
      expectedTexts: ["Hello", " [["],
      repeatFinal: true,
    },
    {
      name: "valid media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      expectedTexts: ["Hello", ""],
      mediaUrls: ["https://example.com/a.png"],
    },
    {
      name: "rejected media path",
      text: "Hello\nMEDIA:../secret.png",
      expectedTexts: ["Hello"],
    },
    {
      name: "withdrawn media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      finalText: "Hello",
      expectedTexts: ["Hello"],
    },
    {
      name: "literal media inside an unclosed fence",
      text: "```text\nMEDIA:https://example.com/a.png",
      expectedTexts: ["```text\n", "MEDIA:https://example.com/a.png"],
    },
  ])("flushes trailing directive tails on stream end: $name", (scenario) => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: scenario.text });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: scenario.finalText ?? scenario.text }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(scenario.expectedTexts.length);
    expect(replyTexts(onBlockReply)).toEqual(scenario.expectedTexts);
    expect(onBlockReply.mock.calls.flatMap(([payload]) => payload.mediaUrls ?? [])).toEqual(
      scenario.mediaUrls ?? [],
    );

    if (scenario.repeatFinal) {
      expect(replyTexts(onBlockReply).join("")).toBe("Hello [[");
      emit({ type: "message_end", message: assistantMessage });
      expect(replyTexts(onBlockReply)).toEqual(["Hello", " [["]);
    }
  });

  it.each([
    { name: "a split reply tag", chunks: ["[[reply_to:1897", "]] Hello", " world"] },
    {
      name: "held whitespace before hidden reasoning",
      chunks: [" \nHello \t", "<think>private</think> [[reply_to_current]] world  "],
    },
    {
      name: "held whitespace before a split reasoning tag",
      chunks: [" \nHello \t<think", ">private</think> [[reply_to_current]] world  "],
    },
  ])("streams partial replies past $name", ({ chunks }) => {
    // Split tags are buffered until complete so partial replies never expose raw
    // directive syntax.
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of chunks) {
      emitAssistantTextDelta({ emit, delta });
    }

    expect(replyTexts(onPartialReply)).toEqual(["Hello", "Hello world"]);
    emitAssistantTextEnd({ emit });
    expect(lastReplyPayload(onPartialReply).text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it("strips a malformed reply prefix when the stream ends", () => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_" });
    emitAssistantTextDelta({ emit, delta: "current] Visible reply" });
    emitAssistantTextEnd({ emit });

    const payload = lastReplyPayload(onPartialReply);
    expect(payload.text).toBe("Visible reply");
    expect(payload.replyToCurrent).toBeUndefined();
    expect(payload.replyToTag).toBeUndefined();
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it("strips a malformed reply prefix from the final block reply", async () => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_" });
    emitAssistantTextDelta({ emit, delta: "current] Visible reply" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current] Visible reply" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe("Visible reply");
    expect(payload.replyToCurrent).toBeFalsy();
    expect(payload.replyToTag).toBeFalsy();
    expect(payload.text).not.toContain("[[reply_to");
  });
});
