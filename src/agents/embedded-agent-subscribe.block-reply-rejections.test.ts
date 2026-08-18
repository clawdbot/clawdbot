// Block-reply rejection tests ensure async callback failures are contained and
// do not escape as process-level unhandled rejections.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

const waitForAsyncCallbacks = async () => {
  // Block reply callbacks are scheduled asynchronously; this drains both
  // microtasks and the immediate queue before checking unhandled rejections.
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

function emitToolRun(params: {
  emit: (evt: unknown) => void;
  toolName: string;
  toolCallId: string;
  result: unknown;
}): void {
  params.emit({
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    args: {},
  });
  params.emit({
    type: "tool_execution_end",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    isError: false,
    result: params.result,
  });
}

describe("subscribeEmbeddedAgentSession block reply rejections", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    // Capture process-level failures so tests prove callback containment.
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("contains rejected async text_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected async message_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello block" });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("retries final metadata after a synchronous text_end callback failure", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Hello [[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        text: "Hello",
        audioAsVoice: true,
      }),
    );
  });

  it("retries final metadata after an async text_end callback rejection", async () => {
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Hello [[audio_as_voice]]";

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

    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        text: "Hello",
        audioAsVoice: true,
      }),
    );
  });

  it("does not duplicate final metadata while an async text_end callback resolves", async () => {
    let resolveReply: (() => void) | undefined;
    const onBlockReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Hello [[audio_as_voice]]";

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

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    resolveReply?.();
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("retries streamed reply targeting after a synchronous callback failure", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Hello [[reply_to_current]]";

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

    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        text: "Hello",
        replyToCurrent: true,
      }),
    );
  });

  it("retries a rejected canonical correction at terminal delivery", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "agent_end", messages: [assistantMessage], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ text: " world" }));
    expect(onBlockReply.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ text: " world" }));
  });

  it("does not exceed one retry for an always-failing canonical reply", async () => {
    const onBlockReply = vi.fn((_payload: { text?: string }) => {
      throw new Error("boom");
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "agent_end", messages: [assistantMessage], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });

  it("discards failed replies when compaction starts a replacement attempt", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Old" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    await subscription.waitForPendingEvents();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "New" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Old", "New"]);
  });

  it("does not wait for stale callbacks after a compaction replacement", async () => {
    let resolveOldReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Old" });
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "New" });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Old", "New"]);
    resolveOldReply?.();
  });

  it("does not let a stale text_end callback block a compaction replacement", async () => {
    let resolveOldReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Old" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "New" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Old", "New"]);
    resolveOldReply?.();
  });

  it("drops a queued stale message_end after compaction invalidates its attempt", async () => {
    let resolveOldReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const oldMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Old" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Old" });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: oldMessage });
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "New" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Old", "New"]);
    resolveOldReply?.();
  });

  it("keeps consecutive compaction replacement generations distinct", async () => {
    let resolveTerminalFlush: (() => void) | undefined;
    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveTerminalFlush = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Old" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();
    emit({ type: "agent_end", messages: [], willRetry: false });
    await Promise.resolve();

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry one", tokensAfter: 100 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Retry one" });
    emitAssistantTextEnd({ emit });
    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry two", tokensAfter: 80 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Retry two" });
    emitAssistantTextEnd({ emit });

    resolveTerminalFlush?.();
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Old", "Retry two"]);
    expect(subscription.isCompacting()).toBe(true);
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.isCompacting()).toBe(false);
  });

  it("supersedes a pending compaction after streamed replacement activity", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-streamed-replacement",
    });

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry one", tokensAfter: 100 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "partial replacement" });
    await subscription.waitForPendingEvents();

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry two", tokensAfter: 80 },
    });
    emit({ type: "agent_end", messages: [], willRetry: false });

    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.isCompacting()).toBe(false);
  });

  it("preserves older pending retries when an active latest retry is superseded", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-preserve-older-retry",
    });

    emit({ type: "compaction_end", willRetry: true });
    emit({ type: "compaction_end", willRetry: true });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "replacement activity" });
    await subscription.waitForPendingEvents();
    emit({ type: "compaction_end", willRetry: true });

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    expect(subscription.isCompacting()).toBe(true);

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.isCompacting()).toBe(false);
  });

  it("does not treat user messages as compaction replacement activity", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-user-message-not-replacement",
    });

    emit({ type: "compaction_end", willRetry: true });
    emit({ type: "message_start", message: { role: "user", content: "queued user input" } });
    await subscription.waitForPendingEvents();
    emit({ type: "compaction_end", willRetry: true });

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    expect(subscription.isCompacting()).toBe(true);

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.isCompacting()).toBe(false);
  });

  it("does not treat transcript-only assistant messages as replacement activity", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-transcript-message-not-replacement",
    });

    emit({ type: "compaction_end", willRetry: true });
    emit({
      type: "message_start",
      message: { role: "assistant", provider: "openclaw", model: "delivery-mirror" },
    });
    await subscription.waitForPendingEvents();
    emit({ type: "compaction_end", willRetry: true });

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    expect(subscription.isCompacting()).toBe(true);

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();
    await subscription.waitForCompactionRetry();
    expect(subscription.isCompacting()).toBe(false);
  });

  it("does not emit stale final metadata after a buffered message_end is invalidated", async () => {
    let resolveOldReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      blockReplyChunking: {
        minChars: 50,
        maxChars: 200,
        breakPreference: "paragraph",
      },
    });
    const oldAnswer = "Old [[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: oldAnswer });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: oldAnswer }],
      } as AssistantMessage,
    });
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "New" });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => ({
        text: (payload as { text?: string } | undefined)?.text,
        audioAsVoice: (payload as { audioAsVoice?: boolean } | undefined)?.audioAsVoice,
      })),
    ).toEqual([
      { text: "Old", audioAsVoice: true },
      { text: "New", audioAsVoice: false },
    ]);
    resolveOldReply?.();
  });

  it("does not release deferred replies from a stale terminal gate", async () => {
    let resolveOldGate: (() => void) | undefined;
    const onBlockReply = vi.fn();
    const onBeforeTerminalDelivery = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldGate = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "text_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Old" });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await Promise.resolve();
    expect(onBlockReply).not.toHaveBeenCalled();

    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Replacement" });
    emit({ type: "agent_end", messages: [], willRetry: false });

    resolveOldGate?.();
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["Replacement"]);
  });

  it("retries failed replies in their original delivery order", async () => {
    const replyRejectors: Array<(reason?: unknown) => void> = [];
    const onBlockReply = vi.fn((_payload: { text?: string }) => {
      if (replyRejectors.length >= 2) {
        return undefined;
      }
      return new Promise<void>((_resolve, reject) => {
        replyRejectors.push(reject);
      });
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 5,
        maxChars: 6,
        breakPreference: "newline",
      },
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "First\nSecond" });
    emitAssistantTextEnd({ emit });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    replyRejectors[1]?.(new Error("second failed first"));
    replyRejectors[0]?.(new Error("first failed second"));
    await subscription.waitForPendingEvents();

    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["First", "Second", "First", "Second"]);
  });

  it("does not duplicate a later successful chunk after an earlier retry is exhausted", async () => {
    const onBlockReply = vi.fn((payload: { text?: string }) => {
      if (payload.text === "First") {
        throw new Error("first chunk failed");
      }
      return undefined;
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 5,
        maxChars: 6,
        breakPreference: "newline",
      },
    });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "First\nSecond" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "First\nSecond" });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: assistantMessage });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as { text?: string } | undefined)?.text),
    ).toEqual(["First", "Second", "First"]);
  });

  it("retries terminal-only tool media after a callback failure", async () => {
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementation(() => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      verboseLevel: "full",
      builtinToolNames: new Set(["image_generate"]),
    });

    emitToolRun({
      emit,
      toolName: "image_generate",
      toolCallId: "tool-1",
      result: {
        content: [{ type: "text", text: "MEDIA:/tmp/generated.png" }],
        details: { media: { mediaUrls: ["/tmp/generated.png"] } },
      },
    });
    emit({ type: "agent_end", messages: [], willRetry: false });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ mediaUrls: ["/tmp/generated.png"] }),
    );
    expect(subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it("contains rejected assistant progress callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const rejectedCallback = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onAgentEvent: rejectedCallback,
      onPartialReply: rejectedCallback,
      onAssistantMessageStart: rejectedCallback,
      onReasoningStream: rejectedCallback,
      onReasoningEnd: rejectedCallback,
      reasoningMode: "stream",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello" });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Because" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end" },
    });
    await waitForAsyncCallbacks();

    expect(rejectedCallback).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected tool presentation callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onToolResult = vi.fn().mockRejectedValue(new Error("tool progress failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
    });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "tool-1",
      result: { content: [{ type: "text", text: "file contents" }] },
    });
    await waitForAsyncCallbacks();

    expect(onToolResult).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected heartbeat response callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onHeartbeatToolResponse = vi.fn().mockRejectedValue(new Error("heartbeat failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onHeartbeatToolResponse,
    });

    emitToolRun({
      emit,
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      toolCallId: "heartbeat-1",
      result: {
        details: {
          status: "accepted",
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        },
      },
    });
    await waitForAsyncCallbacks();

    expect(onHeartbeatToolResponse).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });
});
