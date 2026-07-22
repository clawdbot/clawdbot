// Duplicate block reply tests cover repeated text_end and message_end events
// from providers that replay assistant snapshots.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  createStubSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("does not emit duplicate block replies when text_end repeats", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
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
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
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
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["abcde", "fghij"]);
  });
  it("does not duplicate assistantTexts when message_end repeats", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("keeps the completed assistant independent from transcript mutation", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedAgentSession({ session, runId: "run" });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Current run reply" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    assistantMessage.content = [{ type: "text", text: "Rewritten transcript reply" }];

    expect(subscription.getCurrentAttemptAssistant()?.content).toEqual([
      { type: "text", text: "Current run reply" },
    ]);
  });
  it("does not duplicate assistantTexts when message_end repeats with trailing whitespace changes", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
    });

    const assistantMessageWithNewline = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world\n" }],
    } as AssistantMessage;

    const assistantMessageTrimmed = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessageWithNewline });
    emit({ type: "message_end", message: assistantMessageTrimmed });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("does not duplicate assistantTexts when message_end repeats with reasoning blocks", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Because" },
        { type: "text", text: "Hello world" },
      ],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("populates assistantTexts for non-streaming models with chunking enabled", () => {
    // Non-streaming providers may only send message_end; assistantTexts still
    // needs the final visible reply even when block chunking is enabled.
    // Non-streaming models (e.g. zai/glm-4.7): no text_delta events; message_end
    // must still populate assistantTexts so providers can deliver a final reply.
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      blockReplyChunking: { minChars: 50, maxChars: 200 }, // Chunking enabled
    });

    // Simulate non-streaming model: only message_start and message_end, no text_delta
    emit({ type: "message_start", message: { role: "assistant" } });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Response from non-streaming model" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Response from non-streaming model"]);
  });
});
