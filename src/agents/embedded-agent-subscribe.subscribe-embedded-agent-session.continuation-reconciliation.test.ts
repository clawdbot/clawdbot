import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";

type BlockReplyPayload = {
  text?: string;
  audioAsVoice?: boolean;
  replyToCurrent?: boolean;
};

function requireBlockReplyPayload(onBlockReply: ReturnType<typeof vi.fn>): BlockReplyPayload {
  const call = onBlockReply.mock.calls[0];
  if (!call) {
    throw new Error("expected first block reply call");
  }
  const payload = call[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first block reply payload");
  }
  return payload as BlockReplyPayload;
}

describe("continuation block reply reconciliation", () => {
  it("does not duplicate metadata when message_end flushes a buffered reply", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: { minChars: 50, maxChars: 200 },
    });
    const answer = "Done.\n\n[[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: "Done.",
        audioAsVoice: true,
      }),
    );
  });

  it("does not duplicate metadata after an async buffered message_end flush", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: { minChars: 50, maxChars: 200 },
    });
    const answer = "Done.\n\n[[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: "Done.",
        audioAsVoice: true,
      }),
    );
  });

  it("keeps callback completion order out of canonical reconciliation", async () => {
    const replyResolvers: Array<() => void> = [];
    const onBlockReply = vi.fn((_payload: { text?: string }) => {
      if (replyResolvers.length >= 3) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        replyResolvers.push(resolve);
      });
    });
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 5,
        maxChars: 8,
        breakPreference: "newline",
      },
    });
    const answer = "AAAAA\nBBBBB\nCCCCC\nDDDDD";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emitAssistantTextEnd({ emit });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    for (const resolve of replyResolvers.toReversed()) {
      resolve();
    }
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["AAAAA", "BBBBB", "CCCCC", "DDDDD"]);
  });

  it("does not resend a canonical answer after contiguous hard splits", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: { minChars: 5, maxChars: 5 },
    });
    const answer = "abcdefghij";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["abcde", "fghij"]);
  });

  it("reconciles canonical message_end text and audio metadata after text_end", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Hello");

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world [[audio_as_voice]]" }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    const correction = onBlockReply.mock.calls[1]?.[0] as BlockReplyPayload | undefined;
    expect(correction).toEqual(expect.objectContaining({ text: " world", audioAsVoice: true }));
    expect(JSON.stringify(onAgentEvent.mock.calls)).toContain("Hello world");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("audio_as_voice");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it.each([
    {
      name: "audio",
      directive: "[[audio_as_voice]]",
      expected: { text: "", audioAsVoice: true },
    },
    {
      name: "reply target",
      directive: "[[reply_to_current]]",
      expected: { text: "Hello", replyToCurrent: true },
    },
  ])("delivers final-only $name metadata after text_end", async ({ directive, expected }) => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Hello ${directive}` }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(expect.objectContaining(expected));
    expect(subscription.assistantTexts).toEqual(["Hello"]);
  });

  it("does not re-emit audio metadata already delivered at text_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });
    const answer = "Hello [[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: "Hello",
        audioAsVoice: true,
      }),
    );

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello"]);
  });
});
